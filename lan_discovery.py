"""Find IP cameras on the local network. Explicit, user-triggered — it actively probes the LAN.

Three best-effort signals, merged by IP and scored by :mod:`camera_classifier`:

  * **ONVIF WS-Discovery** — a WS-Discovery ``Probe`` multicast to ``239.255.255.250:3702``; cameras and
    NVRs answer with a ``ProbeMatch`` carrying their service address (XAddrs) and scopes. Stdlib UDP.
  * **mDNS** — browse ``_onvif._tcp`` / ``_rtsp._tcp`` when ``zeroconf`` is importable; silently skipped
    (not an error) when it isn't, so the bridge keeps its lean, no-optional-deps default.
  * **Port confirm** — a short TCP connect to known camera ports on each discovered host.

The socket work lives behind :func:`_ws_discovery`, :func:`_mdns_browse` and :func:`_probe_ports`, which
the tests replace with canned data, so the suite never touches the network. Nothing here runs on its own —
only ``POST /api/cameras/scan`` calls :func:`discover_cameras`.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import re
import socket
import time
import uuid
from urllib.parse import unquote

import camera_classifier

WS_DISCOVERY_ADDR = ("239.255.255.250", 3702)
DEFAULT_TIMEOUT = 4.0
_PROBE_PORTS = tuple(sorted(camera_classifier.CAMERA_PORTS))

# Bounds on the follow-up TCP probe: a device answering the multicast with many fake records (or mDNS
# announcing many addresses) must not turn one scan into a port scan of arbitrary hosts.
MAX_HOSTS = 256
_PROBE_CONCURRENCY = 16
_SCOPES_RE = re.compile(r"<[^>]*Scopes[^>]*>(.*?)</[^>]*Scopes>", re.I | re.S)
_NAME_SCOPE_RE = re.compile(r"onvif://www\.onvif\.org/name/(\S+)", re.I)


def _probe_envelope() -> bytes:
    """A WS-Discovery Probe for ONVIF network video transmitters, with a fresh message id."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
        'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        "<e:Header>"
        f"<w:MessageID>uuid:{uuid.uuid4()}</w:MessageID>"
        "<w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>"
        "<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>"
        "</e:Header>"
        "<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>"
        "</e:Envelope>"
    ).encode()


def _name_from_scopes(scopes: str) -> str | None:
    match = _NAME_SCOPE_RE.search(scopes)
    return unquote(match.group(1)) if match else None


def _ws_discovery(timeout: float) -> list[dict]:
    """Blocking ONVIF WS-Discovery probe. Best-effort; returns ``[{ip, onvif, scopes, name}]`` or []."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    except OSError:
        return []
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.sendto(_probe_envelope(), WS_DISCOVERY_ADDR)
        found: dict[str, dict] = {}
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                data, addr = sock.recvfrom(65535)
            except TimeoutError:
                break
            except OSError:
                break
            text = data.decode("utf-8", "replace")
            # Use the address the reply came from, not the XAddrs inside it: that text is whatever the
            # responder chose to write, so trusting it would let any device point the probe at any host.
            ip = addr[0]
            scopes_match = _SCOPES_RE.search(text)
            scopes = " ".join(scopes_match.group(1).split()) if scopes_match else ""
            found[ip] = {"ip": ip, "onvif": True, "scopes": scopes, "name": _name_from_scopes(scopes)}
        return list(found.values())
    except OSError:
        return []
    finally:
        sock.close()


def _mdns_browse(timeout: float) -> list[dict]:
    """Browse mDNS for ONVIF/RTSP services when ``zeroconf`` is available; [] otherwise (not an error)."""
    try:
        import zeroconf  # type: ignore  # noqa: PLC0415 - optional dependency, imported lazily
    except Exception:
        return []

    services = ("_onvif._tcp.local.", "_rtsp._tcp.local.")
    hosts: dict[str, dict] = {}

    class _Listener:
        def add_service(self, zc, type_, name) -> None:  # noqa: ANN001 - zeroconf is untyped
            info = zc.get_service_info(type_, name, timeout=int(max(1, timeout) * 1000))
            if not info:
                return
            for raw in info.parsed_addresses():
                host = hosts.setdefault(raw, {"ip": raw, "onvif": False, "mdns_services": [], "name": None})
                svc = type_.replace(".local.", "")
                if svc not in host["mdns_services"]:
                    host["mdns_services"].append(svc)
                if svc == "_onvif._tcp":
                    host["onvif"] = True
                host["name"] = host["name"] or (info.server or name).rstrip(".")

        def update_service(self, *_: object) -> None:  # required by the ServiceBrowser API
            pass

        def remove_service(self, *_: object) -> None:
            pass

    zc = zeroconf.Zeroconf()
    try:
        listener = _Listener()
        for svc in services:
            zeroconf.ServiceBrowser(zc, svc, listener)
        time.sleep(timeout)
    finally:
        with contextlib.suppress(Exception):
            zc.close()
    return list(hosts.values())


def _is_lan_address(ip: str) -> bool:
    """True for a private or link-local unicast address: the only kind a LAN camera scan should probe."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])  # drop an IPv6 zone such as fe80::1%eth0
    except ValueError:
        return False
    if addr.is_loopback or addr.is_multicast or addr.is_unspecified:
        return False
    return addr.is_private or addr.is_link_local


async def _probe_ports(ip: str, ports: tuple[int, ...], timeout: float) -> list[int]:
    """Return which of ``ports`` accept a TCP connection on ``ip`` (short timeout, concurrent)."""

    async def check(port: int) -> int | None:
        try:
            async with asyncio.timeout(timeout):
                _, writer = await asyncio.open_connection(ip, port)
        except (TimeoutError, OSError):
            return None
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
        return port

    results = await asyncio.gather(*(check(p) for p in ports))
    return [p for p in results if p is not None]


async def discover_cameras(timeout: float | None = None) -> list[dict]:
    """Discover likely cameras on the LAN and classify each. Cameras sort first, then by IP.

    Each record: ``{ip, name, vendor, ports, onvif, mdns_services, is_camera, confidence, reasons}``.
    """
    window = DEFAULT_TIMEOUT if timeout is None else max(0.5, min(float(timeout), 30.0))

    onvif_hosts, mdns_hosts = await asyncio.gather(
        asyncio.to_thread(_ws_discovery, window),
        asyncio.to_thread(_mdns_browse, window),
    )

    hosts: dict[str, dict] = {}
    for found in (*onvif_hosts, *mdns_hosts):
        host = hosts.setdefault(
            found["ip"], {"ip": found["ip"], "onvif": False, "mdns_services": [], "name": None, "mac": None}
        )
        host["onvif"] = host["onvif"] or found.get("onvif", False)
        host["name"] = host["name"] or found.get("name")
        host["mac"] = host["mac"] or found.get("mac")
        for svc in found.get("mdns_services", []):
            if svc not in host["mdns_services"]:
                host["mdns_services"].append(svc)

    # Only probe addresses on the local network, and at most MAX_HOSTS of them.
    targets = [host for host in hosts.values() if _is_lan_address(host["ip"])][:MAX_HOSTS]
    probe_timeout = min(1.0, window / 2)
    limit = asyncio.Semaphore(_PROBE_CONCURRENCY)

    async def enrich(host: dict) -> dict:
        async with limit:
            ports = await _probe_ports(host["ip"], _PROBE_PORTS, probe_timeout)
        vendor = camera_classifier.vendor_for_mac(host.get("mac"))
        verdict = camera_classifier.classify(
            onvif=host["onvif"],
            mdns_services=host["mdns_services"],
            open_ports=ports,
            vendor=vendor,
            name=host["name"],
        )
        return {
            "ip": host["ip"],
            "name": host["name"],
            "vendor": verdict["vendor"],
            "ports": ports,
            "onvif": host["onvif"],
            "mdns_services": host["mdns_services"],
            "is_camera": verdict["is_camera"],
            "confidence": verdict["confidence"],
            "reasons": verdict["reasons"],
        }

    records = await asyncio.gather(*(enrich(host) for host in targets))
    records.sort(key=lambda r: (not r["is_camera"], r["ip"]))
    return list(records)
