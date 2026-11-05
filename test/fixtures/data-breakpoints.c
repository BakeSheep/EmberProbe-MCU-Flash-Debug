/* Symbols for real ARM GDB watchpoint tests against an in-memory remote target. */
volatile unsigned int watchedCounter = 3;
volatile unsigned char watchedByte = 1;
volatile unsigned short watchedHalfword = 2;

void watchCheckpoint(void) {
    for (;;) {
        watchedCounter++;
    }
}
