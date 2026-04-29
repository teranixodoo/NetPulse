import pkg_resources
v = pkg_resources.get_distribution("pysnmp").version
print(f"pysnmp version: {v}")

# Zkus různé importy
for mod in [
    "pysnmp.hlapi",
    "pysnmp.hlapi.asyncio",
    "pysnmp.hlapi.v1arch",
    "pysnmp.hlapi.v3arch",
    "pysnmp.hlapi.v3arch.asyncio",
]:
    try:
        import importlib
        m = importlib.import_module(mod)
        attrs = [a for a in dir(m) if "getCmd" in a or "SnmpEngine" in a or "CommunityData" in a]
        print(f"  {mod}: {attrs[:5]}")
    except Exception as e:
        print(f"  {mod}: FAIL - {e}")
