import gdb


class SamplePrinter:
    def __init__(self, value):
        self.value = value

    def to_string(self):
        return "explicit sample printer"

    def display_hint(self):
        return "array"

    def children(self):
        for index in range(205):
            yield "[%d]" % index, self.value["values"][index]


class BrokenPrinter:
    def __init__(self, value):
        self.value = value

    def to_string(self):
        return "broken sample printer"

    def children(self):
        raise gdb.GdbError("fixture printer iteration failed")
        yield "unused", self.value


def lookup(value):
    name = str(value.type.strip_typedefs())
    if name == "PrinterSample":
        return SamplePrinter(value)
    if name == "BrokenPrinterSample":
        return BrokenPrinter(value)
    return None


gdb.pretty_printers.append(lookup)
