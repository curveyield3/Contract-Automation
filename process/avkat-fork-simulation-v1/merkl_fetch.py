#!/usr/bin/env python3
"""Read live Merkl claim proofs; emit Solidity fixture and JSON evidence. No writes to chain."""
import json,urllib.request,sys,pathlib,re,datetime
dst=pathlib.Path(sys.argv[1])
report=pathlib.Path(sys.argv[2])
safe="0xf39087af2107eadbf81f10a64051740a76b6291d"
kat="0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d"
url=f"https://api.merkl.xyz/v4/users/{safe}/rewards?chainId=747474"
evidence={"source_url":url,"retrieved_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"mode":"LIVE_MERKL_API"}
picked=None
try:
    req=urllib.request.Request(url,headers={"User-Agent":"AVKAT-fork-validation-v1","Accept":"application/json"})
    with urllib.request.urlopen(req,timeout=25) as resp:
        data=json.load(resp)
    matches=[]
    def recurse(obj):
        if isinstance(obj,list):
            for x in obj: recurse(x)
        elif isinstance(obj,dict):
            token=obj.get("token",{})
            addr=(token.get("address","") if isinstance(token,dict) else token).lower() if isinstance(token,(dict,str)) else ""
            if addr==kat and "amount" in obj:
                amount=int(obj["amount"])
                claimed=int(obj.get("claimed",0))
                proofs=obj.get("proofs",obj.get("proof",[]))
                if isinstance(proofs,str): proofs=[proofs]
                if isinstance(proofs,list) and proofs and all(isinstance(x,str) and re.fullmatch(r"0x[0-9a-fA-F]{64}",x) for x in proofs):
                    matches.append({"amount":amount,"claimed":claimed,"proofs":proofs,"delta":amount-claimed})
            for key,value in obj.items():
                if key in ("rewards","campaignData","747474","chains","data","items"):
                    recurse(value)
    recurse(data)
    evidence["kat_rewards_found"]=len(matches)
    eligible=[x for x in matches if x["delta"]>0]
    if eligible: picked=max(eligible,key=lambda x:x["delta"])
    else: evidence["error"]="NO_ACTIVE_CLAIMABLE_KAT_WITH_VALID_PROOF"
except Exception as ex:
    evidence["error"]=f"MERKL_FETCH_ERROR:{type(ex).__name__}:{str(ex)[:350]}"
if picked:
    amount=picked["amount"]
    proofs=picked["proofs"]
    evidence.update({"amount_cumulative":str(amount),"claimed_api":str(picked["claimed"]),"claimable_raw":str(picked["delta"]),"proof_length":len(proofs)})
else:
    amount=0;proofs=[]
lines=["// Generated from live Merkl API for this fork-only run; never deployed.",
       "// SPDX-License-Identifier: MIT","pragma solidity 0.8.30;",
       "abstract contract MerklProofFixture {",
       f" function _merklAmount() internal pure returns(uint256) {{return {amount};}}",
       " function _merklProof() internal pure returns(bytes32[] memory p) {",
       f"  p=new bytes32[]({len(proofs)});"]
for i,x in enumerate(proofs):lines.append(f"  p[{i}]=bytes32({x});")
lines+=[" }","}"]
dst.parent.mkdir(parents=True,exist_ok=True)
dst.write_text("\n".join(lines)+"\n")
report.parent.mkdir(parents=True,exist_ok=True)
report.write_text(json.dumps(evidence,indent=2)+"\n")
print("MERKL_FETCH:",json.dumps(evidence))
