// Deliberately incompatible typedef: multi-image RTOS decoding must use the primary's variables.
struct TCB_t { char pcTaskName[8]; unsigned uxPriority; unsigned *pxTopOfStack; };
TCB_t secondaryTask = { "Second", 99, nullptr };
int duplicateGlobal = 29;
extern "C" void imageCheckpoint() { for (;;) {} }
