struct PrinterSample { int values[205]; } sample;
struct BrokenPrinterSample { int rawField; } broken = {19};
extern "C" __attribute__((noinline)) void printerCheckpoint() { asm volatile("" ::: "memory"); }
int main() {
    for (int index = 0; index < 205; ++index) sample.values[index] = index;
    printerCheckpoint();
    return 0;
}
