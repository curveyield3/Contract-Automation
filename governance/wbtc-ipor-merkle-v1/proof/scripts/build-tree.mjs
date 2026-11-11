// SPDX-License-Identifier: AGPL-3.0-or-later
// v12 tree builder for WbtcCollateralTokenVoting_v4.registerProvedCollateralWeight.
// WARNING: input positions are UNTRUSTED until a real source-authenticating
// RISC Zero guest proves their complete historical market census.
import fs from 'node:fs';
import { AbiCoder, keccak256, concat, getAddress, getBytes } from 'ethers';

const infile = process.env.SNAPSHOT_PATH || 'output/snapshot.json';
const outfile = process.env.MERKLE_OUTPUT || 'output/merkle.json';
const input = JSON.parse(fs.readFileSync(infile, 'utf8'));
const abi = AbiCoder.defaultAbiCoder();
const fail = (msg) => { throw new Error(`INVALID_SNAPSHOT: ${msg}`); };
if (input.schemaVersion !== 3) fail('expected collateral snapshot schema 3');
const processor = getAddress(input.processor);
const parentId = BigInt(input.parentId);
const penalty = Number(input.collateralPenaltyBps);
if (parentId < 0n || !Number.isInteger(penalty) || penalty < 0 || penalty > 10000)
    fail('bad parent ID or collateral penalty');
if (!Array.isArray(input.positions) || input.positions.length === 0)
    fail('complete collateral positions array required; no inferred empty electorates');

// A delegate may have multiple approved-market positions. The Solidity leaf
// accepts only the aggregate raw shares for this one delegate and parent.
const aggregate = new Map();
for (const p of input.positions) {
    const delegate = getAddress(p.delegate);
    const raw = BigInt(p.rawShares);
    if (raw <= 0n) fail('zero/negative position cannot be a Merkle leaf');
    const key = delegate.toLowerCase();
    aggregate.set(key, (aggregate.get(key) || 0n) + raw);
}
const leafFor = (delegate,raw) => keccak256(abi.encode(
    ['address','uint256','address','uint256'], [processor,parentId,delegate,raw]
));
const hashPair=(a,b) => keccak256(concat(
    a.toLowerCase() < b.toLowerCase() ? [a,b] : [b,a]
));
const members = [...aggregate].map(([address, rawShares]) => ({
    address: getAddress(address), rawShares,
    leaf: leafFor(address, rawShares),
})).sort((a,b) => a.leaf.toLowerCase().localeCompare(b.leaf.toLowerCase()));
const n = members.length;
const nodes = new Array(2*n-1);
for(let i=0;i<n;i++) nodes[n-1+i]=members[i].leaf;
for(let i=n-2;i>=0;i--) nodes[i]=hashPair(nodes[2*i+1],nodes[2*i+2]);
const proofs={};
for(let i=0;i<n;i++){
    let at=n-1+i;
    const siblings=[];
    while(at>0){ siblings.push(nodes[at%2===0?at-1:at+1]); at=Math.floor((at-1)/2); }
    const m=members[i];
    let computed=leafFor(m.address,m.rawShares);
    for(const sibling of siblings) computed=hashPair(computed,sibling);
    if(computed.toLowerCase()!==nodes[0].toLowerCase()) fail('invalid generated membership path');
    proofs[m.address.toLowerCase()]={rawShares:m.rawShares.toString(),proof:siblings};
}
const totalRaw=members.reduce((acc,m)=>acc+m.rawShares,0n);
// Mirrors the onchain _weightedCollateral(rawShares, penaltyBps) for each
// proved delegate. Proof guest MUST authenticate these totals independently.
const totalWeighted=members.reduce((acc,m)=>acc+m.rawShares*BigInt(10000-penalty)/10000n,0n);
const output={schemaVersion:3,processor,parentId:parentId.toString(),
  snapshotBlock:Number(input.snapshotBlock),collateralPenaltyBps:penalty,
  collateralMerkleRoot:nodes[0],rawCollateralShares:totalRaw.toString(),
  weightedCollateralShares:totalWeighted.toString(),
  membershipCount:n,positionsProvided:input.positions.length,
  proofAuthenticated:false,proofs};
fs.mkdirSync(outfile.split('/').slice(0,-1).join('/')||'.',{recursive:true});
fs.writeFileSync(outfile,JSON.stringify(output,null,2)+'\n');
console.log(`MERKLE_FORMAT_ONLY: ${n} delegates, root ${output.collateralMerkleRoot}; proof authenticated=false`);
