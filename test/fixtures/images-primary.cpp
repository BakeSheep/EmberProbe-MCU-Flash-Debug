// This is a layout fixture, not a FreeRTOS firmware or hardware-compatibility claim.
struct ListItem_t { unsigned value; ListItem_t *pxNext; ListItem_t *pxPrevious; void *pvOwner; void *pvContainer; };
struct List_t { unsigned uxNumberOfItems; ListItem_t *index; ListItem_t xListEnd; };
struct TCB_t {
    unsigned *pxTopOfStack;
    unsigned uxPriority;
    unsigned *pxStack;
    unsigned uxBasePriority;
    char pcTaskName[16];
    ListItem_t xEventListItem;
    unsigned *pxEndOfStack;
    unsigned ulRunTimeCounter;
};
unsigned primaryStack[8] = { 0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5, 0, 0, 0, 0 };
TCB_t primaryTask = { primaryStack + 6, 3, primaryStack, 2, "Primary", {}, primaryStack + 7, 123 };
TCB_t * volatile pxCurrentTCB = &primaryTask;
volatile int xSchedulerRunning = 1;
volatile unsigned uxCurrentNumberOfTasks = 1;
List_t pxReadyTasksLists[1] = {{ 0, nullptr, { 0, &pxReadyTasksLists[0].xListEnd, nullptr, nullptr, nullptr } }};
#define EMPTY_LIST(name) List_t name = { 0, nullptr, { 0, &name.xListEnd, nullptr, nullptr, nullptr } }
EMPTY_LIST(delayed);
EMPTY_LIST(overflowDelayed);
EMPTY_LIST(xSuspendedTaskList);
EMPTY_LIST(xPendingReadyList);
EMPTY_LIST(xTasksWaitingTermination);
List_t *pxDelayedTaskList = &delayed;
List_t *pxOverflowDelayedTaskList = &overflowDelayed;
int duplicateGlobal = 17;
extern "C" void imageCheckpoint() { for (;;) {} }
