import asyncio
from pysnmp.hlapi.v3arch.asyncio import (
    SnmpEngine, CommunityData, UdpTransportTarget,
    ContextData, ObjectType, ObjectIdentity, get_cmd,
)

OIDS = {
    "mtBoardName":    "1.3.6.1.4.1.14988.1.1.4.1.0",
    "mtSerialNumber": "1.3.6.1.4.1.14988.1.1.4.2.0",
    "mtSoftwareId":   "1.3.6.1.4.1.14988.1.1.4.3.0",
    "mtFirmware":     "1.3.6.1.4.1.14988.1.1.4.4.0",
    "mtCpuLoad":      "1.3.6.1.4.1.14988.1.1.3.6.0",
    "mtTotalMem":     "1.3.6.1.4.1.14988.1.1.3.1.0",
    "mtFreeMem":      "1.3.6.1.4.1.14988.1.1.3.2.0",
}

async def main():
    engine = SnmpEngine()
    transport = await UdpTransportTarget.create(("93.91.156.129", 161), timeout=5, retries=1)

    for name, oid in OIDS.items():
        eI, eS, eIdx, vbs = await get_cmd(
            engine,
            CommunityData("netinet", mpModel=1),
            transport,
            ContextData(),
            ObjectType(ObjectIdentity(oid)),
        )
        if eI or eS:
            print(f"{name}: ERROR {eI or eS}")
            continue
        val = vbs[0][1]
        cls = type(val).__name__
        # Zobrazíme raw bytes pro binární typy
        if hasattr(val, "asOctets"):
            raw = val.asOctets()
            print(f"{name}: cls={cls} raw_hex={raw.hex()} str={raw!r}")
        else:
            print(f"{name}: cls={cls} val={val!r} int={int(val) if hasattr(val,'__int__') else '?'}")

    engine.closeDispatcher()

asyncio.run(main())
