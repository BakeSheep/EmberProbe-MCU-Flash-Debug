#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WINVER 0x0602
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <initguid.h>
#include <setupapi.h>
#include <devpkey.h>
#include <newdev.h>
#include <shlobj.h>
#include <knownfolders.h>
#include <shellapi.h>
#include <sddl.h>
#include <aclapi.h>
#include <wincrypt.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <wctype.h>
#include <stdint.h>
#include "../vendor/libwdi/libwdi/libwdi.h"
#include "libwdi_hash.h"

/* The CLI has no path, INF, VID or PID override. Every mutation is tied to one present devnode. */
static const unsigned short supported_pids[] = {
    0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0107, 0x0108,
    0x1010, 0x1011, 0x1012, 0x1013, 0x1014, 0x1015, 0x1016,
    0x1017, 0x1018, 0x1020, 0x1051, 0x1055, 0x1061
};

typedef int (WINAPI *wdi_list_fn)(struct wdi_device_info **, struct wdi_options_create_list *);
typedef int (WINAPI *wdi_destroy_fn)(struct wdi_device_info *);
typedef int (WINAPI *wdi_prepare_fn)(struct wdi_device_info *, const char *, const char *, struct wdi_options_prepare_driver *);
typedef int (WINAPI *wdi_install_fn)(struct wdi_device_info *, const char *, const char *, struct wdi_options_install_driver *);
typedef const char *(WINAPI *wdi_error_fn)(int);

static int supported_pid(unsigned int pid) {
    size_t i;
    for (i = 0; i < sizeof(supported_pids) / sizeof(supported_pids[0]); ++i)
        if (supported_pids[i] == pid) return 1;
    return 0;
}

static int valid_oem_inf(const wchar_t *inf) {
    size_t i, length = wcslen(inf);
    if (length < 8 || length > 31 || _wcsnicmp(inf, L"oem", 3) != 0 ||
        _wcsicmp(inf + length - 4, L".inf") != 0) return 0;
    for (i = 3; i < length - 4; ++i) if (inf[i] < L'0' || inf[i] > L'9') return 0;
    return 1;
}

static int verified_libwdi_handle(const wchar_t *path, HANDLE *locked) {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    BYTE bytes[8192], digest[32];
    DWORD count, length = sizeof(digest);
    BOOL read_ok;
    char actual[65];
    int result = 0, i;
    DWORD attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)))
        return 0;
    *locked = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (*locked == INVALID_HANDLE_VALUE) return 0;
    if (!CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
        !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) goto done;
    while ((read_ok = ReadFile(*locked, bytes, sizeof(bytes), &count, NULL)) && count > 0)
        if (!CryptHashData(hash, bytes, count, 0)) goto done;
    if (!read_ok) goto done;
    if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &length, 0) || length != sizeof(digest)) goto done;
    for (i = 0; i < 32; ++i) sprintf(actual + 2 * i, "%02x", digest[i]);
    actual[64] = 0;
    result = _stricmp(actual, EMBERPROBE_LIBWDI_SHA256) == 0;
done:
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    if (!result) { CloseHandle(*locked); *locked = INVALID_HANDLE_VALUE; }
    return result;
}

static int contains_ci(const wchar_t *haystack, const wchar_t *needle) {
    size_t length = wcslen(needle);
    while (*haystack) {
        if (_wcsnicmp(haystack, needle, length) == 0) return 1;
        ++haystack;
    }
    return 0;
}

static int valid_id(const wchar_t *id) {
    unsigned int pid = 0;
    size_t i, n = wcslen(id);
    if (n < 23 || n > 190 || _wcsnicmp(id, L"USB\\VID_1366&PID_", 17) != 0) return 0;
    for (i = 17; i < 21; ++i) if (!iswxdigit(id[i])) return 0;
    if (swscanf(id + 17, L"%4x", &pid) != 1 || !supported_pid(pid)) return 0;
    if (id[21] == L'&') {
        if (_wcsnicmp(id + 21, L"&MI_", 4) != 0 || !iswxdigit(id[25]) ||
            !iswxdigit(id[26]) || id[27] != L'\\' || !id[28]) return 0;
    } else if (id[21] != L'\\' || !id[22]) return 0;
    for (i = 0; i < n; ++i) {
        wchar_t c = id[i];
        if (!((c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z') ||
              (c >= L'0' && c <= L'9') || c == L'\\' || c == L'&' || c == L'_' ||
              c == L'-' || c == L'#' || c == L'{' || c == L'}' || c == L'.')) return 0;
    }
    return 1;
}

static int get_device(const wchar_t *id, HDEVINFO *set, SP_DEVINFO_DATA *data,
                      wchar_t *service, wchar_t *inf, wchar_t *name, wchar_t *provider) {
    DWORD type, needed;
    DEVPROPTYPE property_type;
    *set = SetupDiGetClassDevsW(NULL, NULL, NULL, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if (*set == INVALID_HANDLE_VALUE) return 0;
    ZeroMemory(data, sizeof(*data));
    data->cbSize = sizeof(*data);
    if (!SetupDiOpenDeviceInfoW(*set, id, NULL, 0, data)) return 0;
    service[0] = inf[0] = name[0] = provider[0] = 0;
    if (!SetupDiGetDeviceRegistryPropertyW(*set, data, SPDRP_SERVICE, &type,
                                           (BYTE *)service, 256 * sizeof(wchar_t), &needed)) return 0;
    if (!SetupDiGetDevicePropertyW(*set, data, &DEVPKEY_Device_DriverInfPath, &property_type,
                                   (BYTE *)inf, 256 * sizeof(wchar_t), &needed, 0)) return 0;
    if (!SetupDiGetDevicePropertyW(*set, data, &DEVPKEY_Device_DriverProvider, &property_type,
                                   (BYTE *)provider, 256 * sizeof(wchar_t), &needed, 0)) return 0;
    if (!SetupDiGetDeviceRegistryPropertyW(*set, data, SPDRP_FRIENDLYNAME, &type,
                                           (BYTE *)name, 256 * sizeof(wchar_t), &needed))
        SetupDiGetDeviceRegistryPropertyW(*set, data, SPDRP_DEVICEDESC, &type,
                                          (BYTE *)name, 256 * sizeof(wchar_t), &needed);
    return 1;
}

static void json_string(const wchar_t *value) {
    int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    char *utf8 = size > 0 ? (char *)malloc(size) : NULL;
    const unsigned char *p;
    putchar('"');
    if (utf8 && WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8, size, NULL, NULL)) {
        for (p = (const unsigned char *)utf8; *p; ++p) {
            if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
            else if (*p < 0x20) printf("\\u%04x", *p);
            else putchar(*p);
        }
    }
    free(utf8);
    putchar('"');
}

/* Read-only inventory avoids starting PowerShell and querying every property of every USB device. */
static int list_devices(void) {
    HDEVINFO set = SetupDiGetClassDevsW(NULL, NULL, NULL, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    SP_DEVINFO_DATA device;
    DWORD index = 0, type, needed;
    wchar_t id[256], name[256], parent[256], service[256], provider[256], inf[256];
    GUID container;
    wchar_t container_text[64];
    DEVPROPTYPE property_type;
    int first = 1;
    if (set == INVALID_HANDLE_VALUE) return 5;
    printf("[");
    while (1) {
        ZeroMemory(&device, sizeof(device));
        device.cbSize = sizeof(device);
        if (!SetupDiEnumDeviceInfo(set, index++, &device)) {
            if (GetLastError() != ERROR_NO_MORE_ITEMS) {
                SetupDiDestroyDeviceInfoList(set);
                return 5;
            }
            break;
        }
        if (!SetupDiGetDeviceInstanceIdW(set, &device, id, 256, NULL) ||
            _wcsnicmp(id, L"USB\\VID_1366&PID_", 17) != 0) continue;
        name[0] = parent[0] = service[0] = provider[0] = inf[0] = container_text[0] = 0;
        if (!SetupDiGetDeviceRegistryPropertyW(set, &device, SPDRP_FRIENDLYNAME, &type,
                                               (BYTE *)name, sizeof(name), &needed))
            SetupDiGetDeviceRegistryPropertyW(set, &device, SPDRP_DEVICEDESC, &type,
                                              (BYTE *)name, sizeof(name), &needed);
        SetupDiGetDeviceRegistryPropertyW(set, &device, SPDRP_SERVICE, &type,
                                          (BYTE *)service, sizeof(service), &needed);
        SetupDiGetDevicePropertyW(set, &device, &DEVPKEY_Device_Parent, &property_type,
                                  (BYTE *)parent, sizeof(parent), &needed, 0);
        property_type = 0;
        if (SetupDiGetDevicePropertyW(set, &device, &DEVPKEY_Device_ContainerId, &property_type,
                                      (BYTE *)&container, sizeof(container), &needed, 0) &&
            property_type == DEVPROP_TYPE_GUID) StringFromGUID2(&container, container_text, 64);
        SetupDiGetDevicePropertyW(set, &device, &DEVPKEY_Device_DriverProvider, &property_type,
                                  (BYTE *)provider, sizeof(provider), &needed, 0);
        SetupDiGetDevicePropertyW(set, &device, &DEVPKEY_Device_DriverInfPath, &property_type,
                                  (BYTE *)inf, sizeof(inf), &needed, 0);
        if (!first) putchar(',');
        first = 0;
        printf("{\"instanceId\":"); json_string(id);
        printf(",\"name\":"); json_string(name);
        printf(",\"parentId\":"); json_string(parent);
        printf(",\"containerId\":"); json_string(container_text);
        printf(",\"service\":"); json_string(service);
        printf(",\"driverProvider\":"); json_string(provider);
        printf(",\"driverInf\":"); json_string(inf);
        putchar('}');
    }
    puts("]");
    SetupDiDestroyDeviceInfoList(set);
    return 0;
}

static int excluded_name(const wchar_t *name) {
    return contains_ci(name, L"flasher") || contains_ci(name, L"j-trace") ||
        contains_ci(name, L"jtrace") || contains_ci(name, L"serial") || contains_ci(name, L"vcom");
}

static int debugger_process_running(void) {
    static const wchar_t *names[] = {
        L"Ozone.exe", L"JLink.exe", L"JLinkExe.exe", L"JLinkGDBServer.exe",
        L"JLinkGDBServerCL.exe", L"JFlash.exe", L"JFlashLite.exe", L"openocd.exe"
    };
    PROCESSENTRY32W entry;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    size_t i;
    if (snapshot == INVALID_HANDLE_VALUE) return 1;
    ZeroMemory(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (!Process32FirstW(snapshot, &entry)) { CloseHandle(snapshot); return 1; }
    do {
        for (i = 0; i < sizeof(names) / sizeof(names[0]); ++i)
            if (_wcsicmp(entry.szExeFile, names[i]) == 0) { CloseHandle(snapshot); return 1; }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
    return 0;
}

static int is_administrator(void) {
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    PSID group = NULL;
    BOOL member = FALSE;
    if (!AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                  DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &group)) return 0;
    CheckTokenMembership(NULL, group, &member);
    FreeSid(group);
    return member != FALSE;
}

static int elevate_and_wait(const wchar_t *action, const wchar_t *id) {
    wchar_t executable[MAX_PATH], arguments[512];
    SHELLEXECUTEINFOW request;
    DWORD result = 0;
    DWORD wait_result;
    if (!GetModuleFileNameW(NULL, executable, MAX_PATH)) return 20;
    swprintf(arguments, 512, L"--elevated %ls \"%ls\"", action, id);
    ZeroMemory(&request, sizeof(request));
    request.cbSize = sizeof(request);
    request.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    request.lpVerb = L"runas";
    request.lpFile = executable;
    request.lpParameters = arguments;
    request.nShow = SW_HIDE;
    if (!ShellExecuteExW(&request)) return GetLastError() == ERROR_CANCELLED ? 10 : 20;
    wait_result = WaitForSingleObject(request.hProcess, 300000);
    if (wait_result != WAIT_OBJECT_0) {
        CloseHandle(request.hProcess);
        return 27;
    }
    if (!GetExitCodeProcess(request.hProcess, &result)) result = 20;
    CloseHandle(request.hProcess);
    return (int)result;
}

static uint64_t id_hash(const wchar_t *id) {
    uint64_t hash = UINT64_C(14695981039346656037);
    while (*id) {
        hash ^= (uint64_t)towupper(*id++);
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

static int secure_directory(const wchar_t *path, SECURITY_ATTRIBUTES *attributes, PSECURITY_DESCRIPTOR descriptor) {
    DWORD flags;
    PACL dacl = NULL;
    BOOL present = FALSE, defaulted = FALSE;
    int created = CreateDirectoryW(path, attributes) != FALSE;
    BYTE admin_buffer[SECURITY_MAX_SID_SIZE], system_buffer[SECURITY_MAX_SID_SIZE];
    DWORD admin_size = sizeof(admin_buffer), system_size = sizeof(system_buffer);
    PSID owner = NULL;
    PSECURITY_DESCRIPTOR current = NULL;
    if (!created && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
    flags = GetFileAttributesW(path);
    if (flags == INVALID_FILE_ATTRIBUTES || !(flags & FILE_ATTRIBUTE_DIRECTORY) ||
        (flags & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admin_buffer, &admin_size) ||
        !CreateWellKnownSid(WinLocalSystemSid, NULL, system_buffer, &system_size)) return 0;
    if (created) {
        if (SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                                  admin_buffer, NULL, NULL, NULL) != ERROR_SUCCESS) return 0;
    } else {
        if (GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
                                  &owner, NULL, NULL, NULL, &current) != ERROR_SUCCESS) return 0;
        if (!owner || (!EqualSid(owner, admin_buffer) && !EqualSid(owner, system_buffer))) {
            LocalFree(current);
            return 0;
        }
        LocalFree(current);
    }
    if (!GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted) || !present || !dacl) return 0;
    return SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, dacl, NULL) == ERROR_SUCCESS;
}

static int storage_path(const wchar_t *id, wchar_t *base, wchar_t *original, wchar_t *driver) {
    PWSTR program_data = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    SECURITY_ATTRIBUTES attributes;
    wchar_t parent[MAX_PATH];
    int ok = 0;
    if (FAILED(SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, NULL, &program_data))) return 0;
    if (swprintf(parent, MAX_PATH, L"%ls\\EmberProbe", program_data) < 0 ||
        swprintf(base, MAX_PATH, L"%ls\\drivers\\%016llx", parent, (unsigned long long)id_hash(id)) < 0 ||
        swprintf(original, MAX_PATH, L"%ls\\original", base) < 0 ||
        swprintf(driver, MAX_PATH, L"%ls\\winusb", base) < 0) {
        CoTaskMemFree(program_data);
        return 0;
    }
    CoTaskMemFree(program_data);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:P(A;;FA;;;SY)(A;;FA;;;BA)", SDDL_REVISION_1, &descriptor, NULL)) return 0;
    ZeroMemory(&attributes, sizeof(attributes));
    attributes.nLength = sizeof(attributes);
    attributes.lpSecurityDescriptor = descriptor;
    ok = secure_directory(parent, &attributes, descriptor);
    {
        wchar_t drivers[MAX_PATH];
        swprintf(drivers, MAX_PATH, L"%ls\\drivers", parent);
        ok = ok && secure_directory(drivers, &attributes, descriptor);
    }
    if (ok) ok = secure_directory(base, &attributes, descriptor);
    if (ok) ok = secure_directory(original, &attributes, descriptor);
    if (ok) ok = secure_directory(driver, &attributes, descriptor);
    LocalFree(descriptor);
    return ok;
}

static int run_pnputil_export(const wchar_t *inf, const wchar_t *folder) {
    wchar_t executable[MAX_PATH], command[MAX_PATH * 3], windows[MAX_PATH];
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    DWORD exit_code = 1;
    DWORD wait_result;
    if (!GetWindowsDirectoryW(windows, MAX_PATH)) return 0;
    swprintf(executable, MAX_PATH, L"%ls\\System32\\pnputil.exe", windows);
    swprintf(command, MAX_PATH * 3, L"\"%ls\" /export-driver %ls \"%ls\"", executable, inf, folder);
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    if (!CreateProcessW(executable, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                        NULL, NULL, &startup, &process)) return 0;
    wait_result = WaitForSingleObject(process.hProcess, 60000);
    if (wait_result != WAIT_OBJECT_0) TerminateProcess(process.hProcess, 1);
    else GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return exit_code == 0;
}

static int manifest_path(const wchar_t *base, wchar_t *manifest) {
    return swprintf(manifest, MAX_PATH, L"%ls\\original-driver.txt", base) > 0;
}

static int save_manifest(const wchar_t *base, const wchar_t *id, const wchar_t *inf) {
    wchar_t file[MAX_PATH];
    FILE *stream;
    if (!manifest_path(base, file) || _wfopen_s(&stream, file, L"wt, ccs=UNICODE") != 0) return 0;
    fwprintf(stream, L"%ls\n%ls\n", id, inf);
    return fclose(stream) == 0;
}

static int read_manifest(const wchar_t *base, const wchar_t *id, wchar_t *inf) {
    wchar_t file[MAX_PATH], saved_id[256];
    FILE *stream;
    if (!manifest_path(base, file) || _wfopen_s(&stream, file, L"rt, ccs=UNICODE") != 0) return 0;
    if (!fgetws(saved_id, 256, stream) || !fgetws(inf, 256, stream)) { fclose(stream); return 0; }
    fclose(stream);
    saved_id[wcscspn(saved_id, L"\r\n")] = 0;
    inf[wcscspn(inf, L"\r\n")] = 0;
    return _wcsicmp(saved_id, id) == 0 && valid_oem_inf(inf);
}

static int find_exported_inf(const wchar_t *folder, wchar_t *found) {
    wchar_t pattern[MAX_PATH];
    WIN32_FIND_DATAW item;
    HANDLE search;
    swprintf(pattern, MAX_PATH, L"%ls\\*.inf", folder);
    search = FindFirstFileW(pattern, &item);
    if (search == INVALID_HANDLE_VALUE) return 0;
    if (swprintf(found, MAX_PATH, L"%ls\\%ls", folder, item.cFileName) < 0 ||
        FindNextFileW(search, &item)) { FindClose(search); return 0; }
    FindClose(search);
    return 1;
}

static int empty_directory(const wchar_t *folder) {
    wchar_t pattern[MAX_PATH];
    WIN32_FIND_DATAW item;
    HANDLE search;
    if (swprintf(pattern, MAX_PATH, L"%ls\\*", folder) < 0) return 0;
    search = FindFirstFileW(pattern, &item);
    if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
    do {
        if (wcscmp(item.cFileName, L".") && wcscmp(item.cFileName, L"..")) {
            FindClose(search);
            return 0;
        }
    } while (FindNextFileW(search, &item));
    FindClose(search);
    return 1;
}

static int restore_original(const wchar_t *id, HDEVINFO set, SP_DEVINFO_DATA *device, const wchar_t *base,
                            const wchar_t *original) {
    wchar_t saved_inf[256], exported[MAX_PATH], published[MAX_PATH];
    DWORD required = 0;
    SP_DRVINFO_DATA_W candidate;
    SP_DRVINFO_DETAIL_DATA_W *detail;
    DWORD index = 0;
    BOOL reboot = FALSE;
    HMODULE newdev;
    typedef BOOL (WINAPI *install_device_fn)(HWND, HDEVINFO, PSP_DEVINFO_DATA, PSP_DRVINFO_DATA, DWORD, PBOOL);
    install_device_fn install_device;
    int result = 0;
    if (!read_manifest(base, id, saved_inf) || !find_exported_inf(original, exported)) return 0;
    if (!SetupCopyOEMInfW(exported, NULL, SPOST_PATH, 0, published, MAX_PATH, &required, NULL)) return 0;
    if (!SetupDiBuildDriverInfoList(set, device, SPDIT_COMPATDRIVER)) return 0;
    newdev = LoadLibraryExW(L"newdev.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!newdev) { SetupDiDestroyDriverInfoList(set, device, SPDIT_COMPATDRIVER); return 0; }
    install_device = (install_device_fn)GetProcAddress(newdev, "DiInstallDevice");
    if (!install_device) { FreeLibrary(newdev); SetupDiDestroyDriverInfoList(set, device, SPDIT_COMPATDRIVER); return 0; }
    detail = (SP_DRVINFO_DETAIL_DATA_W *)calloc(1, 16384);
    if (!detail) { FreeLibrary(newdev); SetupDiDestroyDriverInfoList(set, device, SPDIT_COMPATDRIVER); return 0; }
    while (1) {
        const wchar_t *candidate_name, *published_name;
        ZeroMemory(&candidate, sizeof(candidate));
        candidate.cbSize = sizeof(candidate);
        if (!SetupDiEnumDriverInfoW(set, device, SPDIT_COMPATDRIVER, index++, &candidate)) break;
        ZeroMemory(detail, 16384);
        detail->cbSize = sizeof(SP_DRVINFO_DETAIL_DATA_W);
        SetupDiGetDriverInfoDetailW(set, device, &candidate, detail, 16384, &required);
        candidate_name = wcsrchr(detail->InfFileName, L'\\');
        published_name = wcsrchr(published, L'\\');
        candidate_name = candidate_name ? candidate_name + 1 : detail->InfFileName;
        published_name = published_name ? published_name + 1 : published;
        if (_wcsicmp(candidate_name, published_name) == 0 &&
            install_device(NULL, set, device, &candidate, 0, &reboot)) {
            result = 1;
            break;
        }
    }
    free(detail);
    FreeLibrary(newdev);
    SetupDiDestroyDriverInfoList(set, device, SPDIT_COMPATDRIVER);
    return result;
}

static int install_winusb(const wchar_t *id, const wchar_t *base, const wchar_t *original,
                          const wchar_t *driver, const wchar_t *inf) {
    wchar_t executable[MAX_PATH], dll_path[MAX_PATH];
    char id_utf8[512], folder_utf8[MAX_PATH * 3];
    HMODULE library;
    HANDLE locked_dll = INVALID_HANDLE_VALUE;
    struct wdi_device_info *list = NULL, *device;
    struct wdi_options_create_list list_options = { TRUE, FALSE, TRUE };
    struct wdi_options_prepare_driver prepare_options = { 0 };
    struct wdi_options_install_driver install_options = { 0 };
    wdi_list_fn create_list;
    wdi_destroy_fn destroy_list;
    wdi_prepare_fn prepare;
    wdi_install_fn install;
    wdi_error_fn error_text;
    int result = 0, status;
    wchar_t *separator;
    wchar_t existing_inf[256], manifest[MAX_PATH], cached_inf[MAX_PATH], cached_cat[MAX_PATH];
    DWORD inf_attributes, cat_attributes;
    int reuse_package = 0;
    if (!manifest_path(base, manifest)) return 21;
    if (GetFileAttributesW(manifest) != INVALID_FILE_ATTRIBUTES) {
        if (!read_manifest(base, id, existing_inf) || _wcsicmp(existing_inf, inf) != 0 ||
            !find_exported_inf(original, manifest)) return 21;
        if (swprintf(cached_inf, MAX_PATH, L"%ls\\emberprobe-winusb.inf", driver) > 0 &&
            swprintf(cached_cat, MAX_PATH, L"%ls\\emberprobe-winusb.cat", driver) > 0) {
            inf_attributes = GetFileAttributesW(cached_inf);
            cat_attributes = GetFileAttributesW(cached_cat);
            reuse_package = inf_attributes != INVALID_FILE_ATTRIBUTES &&
                cat_attributes != INVALID_FILE_ATTRIBUTES &&
                !(inf_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
                !(cat_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
        }
    } else if (!empty_directory(original) || !run_pnputil_export(inf, original) ||
               !find_exported_inf(original, manifest) || !save_manifest(base, id, inf)) return 21;
    if (!GetModuleFileNameW(NULL, executable, MAX_PATH)) return 22;
    separator = wcsrchr(executable, L'\\');
    if (!separator) return 22;
    *(separator + 1) = 0;
    swprintf(dll_path, MAX_PATH, L"%lslibwdi.dll", executable);
    if (!verified_libwdi_handle(dll_path, &locked_dll)) return 22;
    library = LoadLibraryExW(dll_path, NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    CloseHandle(locked_dll);
    if (!library) return 22;
    create_list = (wdi_list_fn)GetProcAddress(library, "wdi_create_list");
    destroy_list = (wdi_destroy_fn)GetProcAddress(library, "wdi_destroy_list");
    prepare = (wdi_prepare_fn)GetProcAddress(library, "wdi_prepare_driver");
    install = (wdi_install_fn)GetProcAddress(library, "wdi_install_driver");
    error_text = (wdi_error_fn)GetProcAddress(library, "wdi_strerror");
    if (!create_list || !destroy_list || !prepare || !install || !error_text) { FreeLibrary(library); return 22; }
    if (!WideCharToMultiByte(CP_UTF8, 0, id, -1, id_utf8, sizeof(id_utf8), NULL, NULL) ||
        !WideCharToMultiByte(CP_UTF8, 0, driver, -1, folder_utf8, sizeof(folder_utf8), NULL, NULL)) {
        FreeLibrary(library); return 22;
    }
    status = create_list(&list, &list_options);
    if (status != 0) { FreeLibrary(library); return 23; }
    for (device = list; device; device = device->next)
        if (device->device_id && _stricmp(device->device_id, id_utf8) == 0) break;
    if (!device || !device->driver || _stricmp(device->driver, "jlink") != 0 ||
        device->vid != 0x1366 || !supported_pid(device->pid)) result = 24;
    else {
        prepare_options.driver_type = WDI_WINUSB;
        status = reuse_package ? 0 : prepare(device, folder_utf8, "emberprobe-winusb.inf", &prepare_options);
        if (status == 0) {
            install_options.pending_install_timeout = 60000;
            status = install(device, folder_utf8, "emberprobe-winusb.inf", &install_options);
        }
        if (status != 0) {
            fprintf(stderr, "libwdi: %s\n", error_text(status));
            result = 25;
        }
    }
    destroy_list(list);
    FreeLibrary(library);
    return result;
}

static int rollback_if_changed(const wchar_t *id, const wchar_t *inf, const wchar_t *base,
                               const wchar_t *original) {
    int attempt;
    for (attempt = 0; attempt < 30; ++attempt) {
        HDEVINFO set = INVALID_HANDLE_VALUE;
        SP_DEVINFO_DATA device;
        wchar_t service[256], current_inf[256], name[256], provider[256];
        if (get_device(id, &set, &device, service, current_inf, name, provider)) {
            int unchanged = _wcsicmp(service, L"jlink") == 0 &&
                _wcsicmp(current_inf, inf) == 0 && _wcsnicmp(provider, L"SEGGER", 6) == 0;
            int restored = unchanged || restore_original(id, set, &device, base, original);
            SetupDiDestroyDeviceInfoList(set);
            return restored;
        }
        if (set != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(set);
        Sleep(1000);
    }
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    int elevated = 0, result = 0;
    const wchar_t *action, *id;
    HDEVINFO set = INVALID_HANDLE_VALUE;
    SP_DEVINFO_DATA device;
    wchar_t service[256], inf[256], name[256], provider[256];
    wchar_t base[MAX_PATH], original[MAX_PATH], driver[MAX_PATH];
    if (argc == 2 && wcscmp(argv[1], L"list") == 0) return list_devices();
    if (argc == 4 && wcscmp(argv[1], L"--elevated") == 0) {
        elevated = 1; action = argv[2]; id = argv[3];
    } else if (argc == 3) { action = argv[1]; id = argv[2]; }
    else return 2;
    if (wcscmp(action, L"install") && wcscmp(action, L"restore") && wcscmp(action, L"status")) return 2;
    if (!valid_id(id)) return 3;
    if (wcscmp(action, L"status") && !is_administrator())
        return elevated ? 4 : elevate_and_wait(action, id);
    if (!get_device(id, &set, &device, service, inf, name, provider)) { result = 5; goto done; }
    if (wcscmp(action, L"status") == 0) {
        wprintf(L"%ls %ls\n", service, inf);
    } else if (!storage_path(id, base, original, driver)) result = 6;
    else if (wcscmp(action, L"install") == 0) {
        if (_wcsicmp(service, L"WinUSB") == 0) result = 0;
        else if (excluded_name(name) || _wcsicmp(service, L"jlink") != 0 ||
                 _wcsnicmp(provider, L"SEGGER", 6) != 0 ||
                 !valid_oem_inf(inf)) result = 7;
        else if (debugger_process_running()) result = 11;
        else {
            result = install_winusb(id, base, original, driver, inf);
            if (result && !rollback_if_changed(id, inf, base, original)) result = 26;
        }
    } else if (excluded_name(name) || _wcsicmp(service, L"WinUSB") != 0) result = 8;
    else if (debugger_process_running()) result = 11;
    else if (!restore_original(id, set, &device, base, original)) result = 9;
done:
    if (result) fprintf(stderr, "Driver helper failed with code %d (Win32 error %lu)\n", result, GetLastError());
    if (set != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(set);
    return result;
}
