#include "shared.hpp"
struct Plain { static int shared; int x; };
int Plain::shared = 99;
Plain plain{42};
int target = 17;
int &reference = target;
int &&rvalueReference = static_cast<int &&>(target);
struct RefBox { int &ref; int own; };
RefBox refbox{target, 31};
struct Bits { unsigned a : 8; unsigned b : 8; unsigned c : 16; };
Bits bits{1, 2, 3};
struct __attribute__((packed)) Packed { unsigned a : 3; signed b : 5; };
Packed packed{3, -2};
struct UtfBox { char16_t c16; char32_t c32; };
UtfBox utfbox{u'Z', U'Z'};
struct Anonymous { union { int a; float b; }; int tail; };
Anonymous anon{{7}, 8};
template<class T> struct Holder { static Plain object; };
template<> Plain Holder<int>::object{51};
struct Root { Packet nested; int values[2]; };
const Root readonlyRoot{{7}, {8, 9}};
struct Methods { int get() { return 1; } int value; };
int Plain::*memberPointer = &Plain::x;
int (Methods::*methodPointer)() = &Methods::get;
struct VBase { int v; };
struct VDerived : virtual VBase { int own; };
VDerived virtualObject;
int readPacket();
int main() { return plain.x + target + readPacket(); }
