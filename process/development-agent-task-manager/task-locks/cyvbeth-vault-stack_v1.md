# Development Agent Task-Lock State v1

## END-STATE INVARIANT

curveyield3/Smart-Contracts contains a complete, reviewable cyvbETH IPOR vault contract plus deployment and testing stack derived by minimal modification from the current proven cyvbWBTC implementation. cyvbETH must preserve cyvbWBTC behavior, fee/accounting/LTV/keeper/admin/deployment semantics, and testing expectations except where vbETH necessarily replaces vbWBTC and where the keeper may allocate any chosen portion of vault-held vbETH to the Katana Morpho variable market `0x2c4f26c76b4de51d3c9260c15a796cd2a35efab17786d0aa78ca2e638b0f8ba8` (vbETH / yvvbUSDC) as a lending-supply position instead of deploying 100% of vbETH into f(x)/fxMINT. The resulting stack must support keeper-controlled movement/allocation between idle vbETH, the existing cyvbWBTC-equivalent f(x)/fxMINT path adapted to vbETH, and the specified Morpho lending market; compile and focused tests must pass; deployment configuration must be explicit and reproducible; and the available Katana fork/deployment lifecycle validation must pass without weakening existing cyvbWBTC safety or accounting behavior.

## CURRENT MAIN

- Contract-Automation main last checked for this lock: `d7b003d54c838a7c65b1c3e9073a67828ab1c34b`.
- Smart-Contracts live main baseline: `ae583cf5a616200534b06cbd2a20ba04814be07f`.
- Active Smart-Contracts implementation branch: `cyvbeth-vault-stack-v1`; discovery checkpoint `04375c16dd0ac888fc94fc3ccd0edd22a9083138`.

## AUTHORITY

- Human specification in the active task is controlling: cyvbETH is a cyvbWBTC clone with vbETH substituted for vbWBTC, plus keeper-controlled optional lending of vbETH into Morpho Katana market `0x2c4f26c76b4de51d3c9260c15a796cd2a35efab17786d0aa78ca2e638b0f8ba8`.
- Human specification: everything else remains exactly the same as cyvbWBTC.
- Human requirement: create this task/focus lock in Contract-Automation before any Smart-Contracts implementation work.
- `FOCUS/TASK LOCKS/TASK_LOCK_PROTOCOL_v1.md`.
- Live `curveyield3/Smart-Contracts` current main and its current cyvbWBTC implementation, deployment stack, tests, and repository-local instructions once inspected.
- Existing proven public/protocol code must be reused where possible; make the smallest modifications required rather than replacing working implementations.

## SATISFIED

- Task scope/end-state locked before Smart-Contracts implementation.
- Live cyvbWBTC contract, deployment, tests, workflow, and repository-local rules inspected; it is the behavioral baseline.
- vbETH verified as `0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62`.
- No f(x) vbETH collateral pool exists. The matching current cyvbWBTC-manager ETH-side pool is the weETH pool `0x6776ce77f47aab00405fd5776c4baadc68c8ce3d`, using weETH `0x9893989433e7a383Cb313953e4c2365107dc19a7`, fxUSD `0x4c03ff0f44A55e7098a09016E02a01d3cdC2FDF9`, oracle `0x849b9e3119B7c4E4Dd0DdfaD1E0DFe587158692d`, and the same f(x) manager/config family as cyvbWBTC.
- Required Morpho market verified on-chain: `0x2c4f26c76b4de51d3c9260c15a796cd2a35efab17786d0aa78ca2e638b0f8ba8`; loan token vbETH, collateral yvvbUSDC `0x80c34BD3A3569E126e7055831036aa7b212cB159`, LLTV 77%.
- Official IPOR Katana Morpho integration verified: market ID 14, SupplyFuse `0xC66c3F5cC5e1550A0Ff960c06D630A2FBB80E19d`, BalanceFuse `0x83790D83C23461cd22429276406C4f09DB885A85`, Morpho `0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc`.
- Official Chainlink Katana ETH/USD proxy resolved as `0x7BdBDB772f4a073BadD676A567C6ED82049a8eEE`.
- Keeper-allocation rule locked: any selected deployable vbETH portion may go to Morpho instead of f(x); fee/accounting protections cannot be bypassed.
- Smallest-delta rule locked: reuse cyvbWBTC and official IPOR Morpho fuses rather than building a new Morpho protocol adapter.

## REMAINING DELTA

1. Implement the versioned cyvbETH folder by copying/adapting the proven cyvbWBTC stack: vbETH underlying, vbETH↔weETH conversion around the verified f(x) weETH pool, and identical LTV/fee/nested-stable behavior.
2. Add a minimal keeper Morpho allocator wrapper over IPOR's official Morpho SupplyFuse, grant only the exact user-specified Morpho substrate, and put that wrapper before the f(x) fuse in instant-withdraw ordering.
3. Include Morpho supplied vbETH in cyvbETH NAV/PPS accounting and preserve scheduled/instant withdrawal reservation semantics.
4. Add vbETH/weETH price sources and the required CurveYield-router route installer using verified Sushi V3 pools.
5. Create the cyvbETH deployment script and focused unit/fork verification workflow.
6. Compile/test/simulate in GitHub, repair blocking failures, remove the temporary discovery workflow, verify final delta, and leave the implementation branch in a reviewable terminal state.

## PARKED OBSERVATIONS

- Unrelated Smart-Contracts refactors, formatting cleanups, dependency upgrades, audit-system work, browser automation, and Contract-Automation redesign.
- Changes to cyvbWBTC unless a minimal shared fix is strictly required for cyvbETH correctness and live evidence proves the existing behavior is defective.
- New generic protocol adapters or abstractions when an existing IPOR/Morpho implementation can be copied or minimally adapted.
- Production transactions or production keeper actions; this task is contract/deployment/testing-stack implementation and validation.

## ACTIVE BLOCKER

None.

## NEXT ACTION

Create the cyvbETH implementation files on `cyvbeth-vault-stack-v1` by cloning the live cyvbWBTC equivalents and applying only the verified vbETH/weETH/Morpho delta above.
