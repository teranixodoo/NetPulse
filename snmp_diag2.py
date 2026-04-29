import importlib

try:
    import pysnmp
    print(f"pysnmp: {pysnmp.__file__}")
    print(f"version: {getattr(pysnmp, '__version__', 'unknown')}")
except Exception as e:
    print(f"FAIL: {e}")

for mod in [
    "pysnmp.hlapi",
    "pysnmp.hlapi.asyncio",
    "pysnmp.hlapi.v1arch",
    "pysnmp.hlapi.v3arch",
    "pysnmp.hlapi.v3arch.asyncio",
]:
    try:
        m = importlib.import_module(mod)
        attrs = [a for a in dir(m) if any(x in a for x in ["getCmd","SnmpEngine","CommunityData"])]
        print(f"OK  {mod}: {attrs[:5]}")
    except Exception as e:
        print(f"ERR {mod}: {e}")
