# 外部 GDB Server

[English](external-gdb-server.en.md)

用 EmberProbe 的调试器 attach 到你自己启动的 Cortex-M / ARM32 TCP GDB server。**这是实验性功能，默认关闭，尚未对具体服务器或板卡做兼容性验证。**

## 配置

1. 在目标工作区或文件夹的 VS Code 设置中开启：

   ```json
   {
     "emberprobe.experimental.externalGdb.enabled": true,
     "emberprobe.experimental.externalGdb.target": "127.0.0.1:3333",
     "emberprobe.experimental.externalGdb.connectionMode": "extended-remote"
   }
   ```

   `target` 写 `host:port` 或 `[IPv6]:port`，不支持串口、URL 或管道。`connectionMode` 可选 `remote` 和 `extended-remote`。

2. 在 `launch.json` 添加配置：

   ```json
   {
     "name": "External GDB attach",
     "type": "emberprobe",
     "request": "attach",
     "servertype": "external",
     "executable": "${workspaceFolder}/build/app.elf"
   }
   ```

3. 启动你的 GDB server，然后在 VS Code 的“运行和调试”中选择这项配置，按 F5。

需要受信任的工作区、与目标固件一致的本地 ELF，以及已配置的工具链。侧栏、右键和 Agent 的调试入口仍然使用 OpenOCD，不受这个开关影响。

## 可以做什么

- 断点、调用栈、变量、STL 显示、暂停、继续、单步。
- 暂停时读取内存，以及在侧栏读写变量。

attach 时目标如果还在运行，会被中断，因此 attach 可能暂停目标。

RTOS 线程由服务器提供，EmberProbe 不配置服务器的 RTOS。

## 结束和恢复

1. 在 VS Code 停止调试。这只断开连接并退出本地 GDB，目标的状态取决于服务器。
2. 自己停止外部服务器，确认它已释放探针。
3. 关闭 `emberprobe.experimental.externalGdb.enabled`。
4. 手动使用采样、烧录等功能，它们不会自动恢复。

尝试过外部连接后，EmberProbe 会暂时阻止自己使用探针，以免抢占，重载窗口后仍然有效，完成上面的步骤才解除。这个保护只对当前窗口的 EmberProbe 有效，挡不住其他程序或窗口。

## 限制

不支持下载、自动复位、Restart、多核共享、运行时采样、SWO/RTT，也不管理服务器和驱动。

EmberProbe 不主动发送 OpenOCD `monitor` 命令。你在配置里写的 attach hooks 会照常执行，请自行确认服务器兼容性。

## 相关文档

- [调试会话设计](../../design/debug-sessions.md)
- [调试工具链](../getting-started/toolchain.md)
