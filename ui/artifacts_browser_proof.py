#!/usr/bin/env python3
"""Real Chromium proof for authenticated Governance startup.

Requires: local_server.py on :7780, Chromium remote debugging on :9223.
The target is navigated to its local origin before document injection; this
avoids the about:blank sessionStorage/security-context failure mode.
"""
import base64, json, pathlib, time, urllib.request
import websocket

ORIGIN = "http://127.0.0.1:7780"
OUT = pathlib.Path("/home/andy/hermes-run/governance-browser-proof")
WALLET = "11111111111111111111111111111111"
GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"


def target():
    req = urllib.request.Request(f"http://127.0.0.1:9223/json/new?{ORIGIN}/app.html", method="PUT")
    return json.load(urllib.request.urlopen(req))["webSocketDebuggerUrl"]

ws = websocket.create_connection(target(), timeout=10)
seq = 0

def cdp(method, params=None):
    global seq
    seq += 1
    ws.send(json.dumps({"id": seq, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == seq:
            return msg

fixture = {
    "schemaVersion": "customer-governance/v1", "network": "mainnet-beta",
    "freshness": {"state": "fresh", "observedAt": "2026-10-09T10:00:00Z", "finalizedSlot": 123},
    "wallets": [{"address": WALLET, "vaults": [{
        "identity": {"provider": "squads", "generation": "v4", "multisigAddress": WALLET, "vaultIndex": 0, "vaultAddress": WALLET},
        "display": {"name": "Canonical vault"},
        "membership": {"role": "member", "permissions": ["vote"], "threshold": 2, "memberCount": 3},
        "requiresAttention": [{"id": "active-1", "status": "active", "decodedIntent": {"summary": "Transfer 1 USDG"}, "approvalProgress": {"approved": 1, "threshold": 2}, "userStatus": "approval_required", "proposer": WALLET, "createdSlot": 100, "finalizedSlot": None, "sourceSignature": "", "instructions": [{"index": 0, "programId": WALLET, "accounts": [WALLET], "intent": {"kind": "transfer", "summary": "unresolved raw instruction"}, "unresolved": True}], "provenance": {"decoderFamily": "unknown", "decoderVersion": "0", "artifactHash": ""}, "unresolvedInstructionCount": 1}],
        "currentActions": [{"id": "current-1", "status": "active", "decodedIntent": {"summary": "Pending approval action"}, "approvalProgress": {"approved": 1, "threshold": 2}, "userStatus": "approval_required", "proposer": WALLET, "createdSlot": 150, "sourceSignature": "CurrentSig"}],
        "recentChanges": [{"id": f"executed-{i}", "status": "executed", "decodedIntent": {"summary": f"Executed change {i}"}, "proposer": WALLET, "approvalProgress": {"approved": 2, "threshold": 2}, "userStatus": "approved", "createdSlot": 200+i, "finalizedSlot": 201+i, "sourceSignature": "Sig-123"} for i in range(9)],
        "nextHistoryCursor": "cursor-page-2"
    }]}], "warnings": []
}
page2 = {**fixture, "freshness": {**fixture["freshness"], "finalizedSlot": 124}, "wallets": [{**fixture["wallets"][0], "vaults": [{**fixture["wallets"][0]["vaults"][0], "requiresAttention": [], "recentChanges": [{"id": "older-13", "status": "executed", "decodedIntent": {"summary": "Older executed change"}, "createdSlot": 180}], "nextHistoryCursor": None}]}]}

source = f"""(() => {{
 const fixture={json.dumps(fixture)}, page2={json.dumps(page2)}, wallet={json.dumps(WALLET)}, token='controlled-proof-token';
 sessionStorage.clear(); localStorage.clear();
 sessionStorage.setItem('kelvara_network_context','mainnet-beta');
 sessionStorage.setItem('kelvara_app_session',JSON.stringify({{wallet,source:'phantom',token,network:'mainnet-beta',genesisHash:{json.dumps(GENESIS)}}}));
 window.phantom={{solana:{{isConnected:true,publicKey:{{toString:()=>wallet}},connect:async()=>({{publicKey:{{toString:()=>wallet}}}}),disconnect:async()=>{{}}}}}};
 const realFetch=window.fetch; window.fetch=async(input,init)=>{{const u=String(input); if(u.includes('/api/governance')) return new Response(JSON.stringify(u.includes('cursor=')?page2:fixture),{{status:200,headers:{{'Content-Type':'application/json'}}}}); if(u.includes('/healthz')) return new Response('{{}}',{{status:200,headers:{{'Content-Type':'application/json'}}}}); if(u.includes('/api/portfolio')) return new Response(JSON.stringify({{positions:[],safeguards:[],protocolStatuses:[],coverage:{{}}}}),{{status:200,headers:{{'Content-Type':'application/json'}}}}); if(u.includes('/api/protection')) return new Response(JSON.stringify({{armed:false}}),{{status:200,headers:{{'Content-Type':'application/json'}}}}); return realFetch(input,init)}};
}})()"""

# Target already has a local origin. Install before reload, never on about:blank.
cdp("Page.enable"); cdp("Runtime.enable"); cdp("Log.enable")
cdp("Page.addScriptToEvaluateOnNewDocument", {"source": source})
cdp("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
cdp("Page.reload", {"ignoreCache": True})
time.sleep(3)

# Real nav click, not a direct hash-only shortcut.
cdp("Runtime.evaluate", {"expression": "document.querySelector('.workspace-nav a[href=\\\"#governance\\\"]')?.click()"})
time.sleep(1)

def evaluate(expr):
    result = cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return result.get("result", {}).get("result", {}).get("value")

def evidence():
    return evaluate("""(() => {const host=document.querySelector('#governance-content'); return {
      url:location.href, hash:location.hash, workspaceHidden:document.querySelector('#connected-workspace')?.hidden,
      nav:[...document.querySelectorAll('.workspace-nav a')].map(a=>({text:a.textContent,active:a.classList.contains('active')})),
      text:host?.innerText||'', html:host?.innerHTML||'', buttons:host?[...host.querySelectorAll('button')].map(b=>b.textContent.trim()):[],
      scrollWidth:document.documentElement.scrollWidth, clientWidth:document.documentElement.clientWidth,
      sectionRects:[...document.querySelectorAll('.governance-vault > h4')].map(node=>({label:node.textContent.trim(),top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom})),
      actionRects:[...document.querySelectorAll('.governance-action')].map(node=>({top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom})),
      recentActionCount:(()=>{const heading=[...document.querySelectorAll('.governance-vault > h4')].find(node=>node.textContent.trim()==='Recent changes');let count=0;for(let node=heading?.nextElementSibling;node&&!node.matches('h4');node=node.nextElementSibling)if(node.matches('.governance-action'))count++;return count})(),
      warningGeometry:[...document.querySelectorAll('.governance-warning')].map(node=>{const r=node.getBoundingClientRect(),previous=node.previousElementSibling?.getBoundingClientRect(),details=node.nextElementSibling?.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,previousBottom:previous?.bottom,detailsTop:details?.top,display:getComputedStyle(node).display}}),
      xssExecuted:Boolean(window.__governanceXssSentinel)
    }})()""")

OUT.mkdir(parents=True, exist_ok=True)
def save(name, value): (OUT / name).write_text(json.dumps(value, indent=2))
def shot(name):
    data = cdp("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})["result"]["data"]
    (OUT / name).write_bytes(base64.b64decode(data))

before = evidence(); save("governance-desktop-before.json", before); shot("governance-desktop.png")
# Pagination button is the real rendered action; assert one older item and no duplicate.
evaluate("[...document.querySelectorAll('#governance-content button')].find(b=>/older|more|history/i.test(b.textContent))?.click()")
time.sleep(1)
after = evidence(); save("governance-desktop-after.json", after)
cdp("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True})
time.sleep(.5)
save("governance-mobile.json", evidence()); shot("governance-mobile.png")
# Drain CDP diagnostics after the run.
messages=[]
ws.settimeout(.2)
try:
    while True:
        m=json.loads(ws.recv())
        if m.get("method") in ("Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"): messages.append(m)
except Exception: pass
(OUT / "console-diagnostics.json").write_text(json.dumps(messages, indent=2))
print(json.dumps({"before": before, "after": after, "out": str(OUT)}, indent=2))
assert before["workspaceHidden"] is False and before["hash"] == "#governance"
assert any(n["text"] == "Governance" and n["active"] for n in before["nav"])
assert "Freshness: fresh" in before["text"] and "executed" in before["text"] and "Unknown" in before["text"] and "Pending approval action" in before["text"]
assert before["text"].count("Executed change") == 9
assert before["recentActionCount"] == 9
assert "[object Object]" not in before["text"] and not before["xssExecuted"]
assert after["text"].count("Older executed change") == 1 and "Older executed change" in after["html"]
assert after["text"].count("Executed change") == 9 and after["text"].count("Older executed change") == 1
assert after["recentActionCount"] == 10
assert "Transfer 1 USDG" in after["text"] and "Pending approval action" in after["text"]
assert before["scrollWidth"] <= before["clientWidth"] and after["scrollWidth"] <= after["clientWidth"]
for evidence_set in (before, after):
    rects=evidence_set["actionRects"]
    assert all(rects[i]["bottom"] <= rects[i+1]["top"] for i in range(len(rects)-1)), rects
    assert evidence_set["sectionRects"]
    for warning in evidence_set["warningGeometry"]:
        assert warning["previousBottom"] <= warning["top"] and warning["bottom"] <= warning["detailsTop"], warning
mobile = json.loads((OUT / "governance-mobile.json").read_text())
assert mobile["scrollWidth"] <= mobile["clientWidth"]
assert "Pending approval action" in mobile["text"] and "Older executed change" in mobile["text"]
