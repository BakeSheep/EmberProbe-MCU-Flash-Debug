struct ClassLeft {
    virtual ~ClassLeft() = default;
    int repeated = 11;
protected:
    int protectedValue = 12;
private:
    int privateValue = 13;
};
struct ClassRight {
    int repeated = 21;
};
struct ClassDerived : ClassLeft, ClassRight {
    int repeated = 31;
    int derivedOnly = 32;
    union { int anonymousInt; float anonymousFloat; };
    struct { int anonymousNested; };
    ClassDerived() : anonymousInt(41), anonymousNested(51) {}
};
ClassDerived classObject;
ClassLeft *polymorphic = &classObject;
const ClassDerived constClassObject;
struct VirtualRoot { int virtualValue = 61; };
struct VirtualLeft : virtual VirtualRoot { int leftValue = 62; };
struct VirtualRight : virtual VirtualRoot { int rightValue = 63; };
struct VirtualDiamond : VirtualLeft, VirtualRight { int ownValue = 64; };
VirtualDiamond virtualObject;
