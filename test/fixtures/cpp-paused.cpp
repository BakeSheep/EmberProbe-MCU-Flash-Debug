#include <array>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

std::string shortText = "hello";
std::string longText(512, 'x');
std::string emptyText;
std::vector<int> numbers(300);
std::vector<int> emptyVector;
std::array<int, 3> fixed = {4, 5, 6};
std::pair<int, std::string> pairValue = {7, "pair"};
std::tuple<int, std::string> tupleValue = {8, "tuple"};
std::map<int, std::vector<int>> ordered = {{1, {11, 12}}, {2, {21}}};
std::unordered_map<int, std::string> unordered = {{3, "three"}, {4, "four"}};
std::map<std::string, int> keyedMap = {{"key", 61}};
std::unordered_map<std::string, int> keyedHash = {{"hash", 63}};
std::unique_ptr<int> uniqueValue = std::make_unique<int>(17);
std::shared_ptr<int> sharedValue = std::make_shared<int>(19);
const std::shared_ptr<int> constOwner = std::make_shared<int>(41);
int rawValue = 7;
int* const rawPointer = &rawValue;
struct RawOwner { int* pointer; };
const RawOwner rawOwner = {&rawValue};
const int* const readonlyRawPointer = &rawValue;
std::shared_ptr<const int> constPointee = std::make_shared<const int>(43);
std::unique_ptr<int> emptyPointer;
std::optional<int> present = 23;
std::optional<int> absent;
std::variant<int, std::string> choice = 29;
std::vector<bool> bits(205, true);
std::map<int, int> manyPairs;
std::map<int, int> emptyMap;
std::unordered_map<int, std::string> emptyHash;
std::shared_ptr<int> emptyShared;
std::array<int, 0> emptyArray;
std::tuple<> emptyTuple;
std::tuple<int, int, std::string> repeatedTuple = {1, 2, "three"};
std::string embeddedNul("a\0b", 3);
const std::vector<int> constNumbers = {1, 2};
using VectorAlias = std::vector<int>;
VectorAlias aliasNumbers = {31, 32};
std::optional<std::vector<int>> nestedOptional = std::vector<int>{51, 52};

extern "C" __attribute__((noinline)) void checkpoint() {
    asm volatile("" ::: "memory");
}

int main() {
    for (int index = 0; index < 300; ++index) numbers[index] = index;
    for (int index = 0; index < 205; ++index) manyPairs.emplace(index, index + 10);
    bits[100] = false;
    checkpoint();
    numbers.push_back(300);
    numbers.erase(numbers.begin());
    choice = std::string("changed");
    checkpoint();
    return numbers[0] == 1 ? 0 : 1;
}
