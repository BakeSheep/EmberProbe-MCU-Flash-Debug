#include <array>
#include <string>
#include <vector>
#include <memory>
#include <optional>
#include <variant>
#include <tuple>
#include <list>
#include <forward_list>
#include <deque>
#include <map>
#include <set>
#include <unordered_map>
#include <unordered_set>

std::string text;
std::vector<int> values;
std::vector<bool> bits;
std::array<int, 3> fixed = {1, 2, 3};
std::unique_ptr<int> unique;
std::shared_ptr<int> shared;
std::weak_ptr<int> weak;
std::optional<int> optional;
std::variant<int, float> variant;
std::pair<int, int> pair = {5, 6};
std::tuple<int, int> tuple = {7, 8};
std::list<int> linked;
std::forward_list<int> forward;
std::deque<int> deque;
std::map<int, int> ordered;
std::multimap<int, int> multiMap;
std::set<int> set;
std::multiset<int> multiSet;
std::unordered_map<int, int> hashed;
std::unordered_multimap<int, int> multiHash;
std::unordered_set<int> hashSet;
std::unordered_multiset<int> hashMultiSet;
int number = 17;
char testHeap[8192];
int& reference = number;
struct Base { virtual ~Base() = default; int base = 1; };
struct Derived : Base { int value = 2; };
Derived derived;
Base* polymorphic = &derived;
extern "C" void entry() {}
extern "C" { void* __dso_handle = &__dso_handle; }
