// Pointer target display fixture. Rebuild with: node scripts/build-pointer-fixture.js pointer-targets
#include <cstdint>

namespace lab {
struct Widget {
    unsigned long id;
    float x, y, z, speed;
    Widget* parent;
    const char* label;
};

Widget g_widgets[3] = {
    {1, 1, 2, 3, 1.8f, nullptr, "root"},
    {2, 4, 5, 6, 1.5f, nullptr, "motor"},
    {10321, 7, 8, 9, 2.5f, nullptr, "fan"},
};
Widget* g_widgetTable[4] = {&g_widgets[0], &g_widgets[1], nullptr, &g_widgets[2]};
Widget* g_focus = &g_widgets[1];
const char* g_name = "hello";
char g_ramText[8] = "ram";
char* g_ramPtr = g_ramText;
int g_counter = 42;
int* g_counterPtr = &g_counter;
struct Square {
    int x, y, w;
    struct {
        short lo, hi;
    } span;
};
Square g_square = {1, 2, 3, {4, 5}};
int g_grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
float* g_innerFloat = &g_widgets[2].y;
int* g_namedView = &g_square.w;
short* g_spanHi = &g_square.span.hi;
int* g_gridCell = &g_grid[1][2];

void tick(Widget& widget) { widget.id++; }
void (*g_hook)(Widget&) = tick;
volatile uint32_t* g_reg = reinterpret_cast<volatile uint32_t*>(0x40020014);
} // namespace lab

int main() {
    lab::g_widgets[1].parent = &lab::g_widgets[0];
    lab::g_widgets[2].parent = &lab::g_widgets[1];
    lab::g_hook(lab::g_widgets[0]);
    for (;;) {
    }
}
