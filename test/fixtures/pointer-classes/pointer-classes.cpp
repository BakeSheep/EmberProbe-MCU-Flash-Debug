// Pointer and C++ internal-member display fixture. Rebuild with scripts/build-pointer-fixture.js.
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <vector>

namespace std {
void __throw_bad_function_call() {
    for (;;) {
    }
}
void __throw_length_error(const char*) {
    for (;;) {
    }
}
void __throw_bad_alloc() {
    for (;;) {
    }
}
void __throw_bad_array_new_length() {
    for (;;) {
    }
}
void __glibcxx_assert_fail(const char*, int, const char*, const char*) noexcept {
    for (;;) {
    }
}
} // namespace std

extern "C" {
void* __dso_handle;
int __aeabi_atexit(void*, void (*)(void*), void*) { return 0; }
void* memcpy(void* target, const void* source, std::size_t size) {
    auto* out = static_cast<unsigned char*>(target);
    auto* in = static_cast<const unsigned char*>(source);
    while (size--) *out++ = *in++;
    return target;
}
}

alignas(8) static unsigned char heap[256];
static std::size_t heapUsed;
void* operator new(std::size_t size) {
    void* block = heap + heapUsed;
    heapUsed += (size + 7) & ~std::size_t(7);
    return block;
}
void operator delete(void*) noexcept {}
void operator delete(void*, std::size_t) noexcept {}

struct Listener {
    virtual void onEvent(int) {}
    virtual ~Listener() = default;
};

class Widget : public Listener {
public:
    Widget* parent = nullptr;
    Widget* nextSibling = nullptr;
    const char* label = "motor";
    void (*onClick)(Widget&) = nullptr;
    void* userData = nullptr;
    int x = 1;
    int y = 2;
};

class MotorController : public Widget {
public:
    float speed = 0.5f;
    int32_t position = 100;
    std::function<void(int)> callback;
    std::atomic<int> state{0};
    uint8_t* rxBuffer = nullptr;
    void onEvent(int event) override { position += event; }
};

typedef struct Opaque* OpaqueHandle;

struct Node {
    Node* peer;
    void* ctx;
    int value;
};

struct Fleet {
    std::vector<Node> nodes;
    Widget* owner;
    OpaqueHandle handle;
    int count;
};

uint8_t rxBuf[32];
MotorController motor;
Fleet fleet;
int32_t* counterPtr = &motor.position;
void (*idleHook)(Widget&) = nullptr;

void clickHandler(Widget& widget) { widget.x++; }

int main() {
    motor.callback = [](int value) { motor.position += value; };
    motor.onClick = clickHandler;
    motor.rxBuffer = rxBuf + 12;
    motor.parent = &motor;
    fleet.nodes.push_back(Node{nullptr, nullptr, 1});
    fleet.owner = &motor;
    idleHook = clickHandler;
    motor.onEvent(1);
    for (;;) {
    }
}
