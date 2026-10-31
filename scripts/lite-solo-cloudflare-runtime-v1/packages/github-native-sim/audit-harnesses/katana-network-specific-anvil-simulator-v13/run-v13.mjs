#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROUTER = '0x01F9894f92ea9224fECc8C35482E20a05De13582';
const SAFE = '0x47623C62f281807D615eeb4A2CEee9d97F9D3C49';
const SUSHI_FACTORY = '0x203e8740894c8955cB8950759876d7E7E45E04c1';
const TARGET_FXUSD_VBUSDC_POOL = '0x2d43e7931329dbb709f33d7049c937c6794bae10';
const FXUSD = '0x4c03ff0f44A55e7098a09016E02a01d3cdC2FDF9';
const VBUSDC = '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36';
const VBWBTC = '0x0913DA6Da4b42f538B445599b46Bb4622342Cf52';

const FXUSD_TO_VBUSDC = '0x4c03ff0f44a55e7098a09016e02a01d3cdc2fdf9000064203a662b0bd271a6ed5a60edfbd04bfce608fd36';
const VBUSDC_TO_FXUSD = '0x203a662b0bd271a6ed5a60edfbd04bfce608fd360000644c03ff0f44a55e7098a09016e02a01d3cdc2fdf9';
const VBUSDC_TO_VBWBTC = '0x203a662b0bd271a6ed5a60edfbd04bfce608fd360001f40913da6da4b42f538b445599b46bb4622342cf52';

const FUNDING_ACCOUNT = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae';
const DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEV_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TWAP_WINDOW = 900;
const MAX_TWAP_DEVIATION_BPS = 200;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}
function lower(x) { return String(x).toLowerCase(); }
function assert(x, m) { if (!x) throw new Error(m); }

async function run(command, args, { cwd, env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; process.stdout.write(c); });
    child.stderr.on('data', c => { stderr += c; process.stderr.write(c); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function waitRpc(provider, child) {
  for (let i=0;i<60;i++) {
    if (child.exitCode !== null) throw new Error('Anvil exited before RPC became ready');
    try {
      const id = await provider.send('eth_chainId', []);
      if (BigInt(id) === 747474n) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Anvil RPC did not become ready');
}

async function safeExec({ provider, safeIface, routerIface, owner, routerData, ethers }) {
  const sig = ethers.solidityPacked(['uint256','uint256','uint8'], [BigInt(owner),0n,1]);
  const data = safeIface.encodeFunctionData('execTransaction',[
    ROUTER,0n,routerData,0,0n,0n,0n,ethers.ZeroAddress,ethers.ZeroAddress,sig
  ]);
  const hash = await provider.send('eth_sendTransaction',[{
    from: owner,
    to: SAFE,
    data,
    gas: ethers.toQuantity(7_000_000n)
  }]);
  const receipt = await provider.waitForTransaction(hash);
  assert(receipt && receipt.status === 1, 'Safe router configuration failed');
}

async function configureRoute({ provider, safeIface, router, owner, tokenIn, tokenOut, route, ethers }) {
  await safeExec({provider,safeIface,routerIface:router.interface,owner,routerData:router.interface.encodeFunctionData('setRoute',[tokenIn,tokenOut,route]),ethers});
  await safeExec({provider,safeIface,routerIface:router.interface,owner,routerData:router.interface.encodeFunctionData('setRouteFeeBps',[tokenIn,tokenOut,0]),ethers});
  await safeExec({provider,safeIface,routerIface:router.interface,owner,routerData:router.interface.encodeFunctionData('setRouteTwapGuard',[tokenIn,tokenOut,TWAP_WINDOW,MAX_TWAP_DEVIATION_BPS]),ethers});
  const installed = await router.routeFor(tokenIn, tokenOut);
  const guard = await router.routeTwapGuard(tokenIn, tokenOut);
  assert(lower(installed) === lower(route), 'route mismatch');
  assert(Number(guard[0])===TWAP_WINDOW && Number(guard[1])===MAX_TWAP_DEVIATION_BPS && guard[2]===true, 'guard mismatch');
  return {tokenIn,tokenOut,route:installed,routeFeeBps:0,twapWindow:Number(guard[0]),maxDeviationBps:Number(guard[1])};
}

async function configureRoutes(provider, ethers) {
  const factory = new ethers.Contract(SUSHI_FACTORY,['function getPool(address,address,uint24) view returns(address)'],provider);
  const pool = await factory.getPool(FXUSD,VBUSDC,100);
  assert(lower(pool)===lower(TARGET_FXUSD_VBUSDC_POOL),'wrong target Sushi pool');

  const routerAbi=[
    'function owner() view returns(address)',
    'function routeFor(address,address) view returns(bytes)',
    'function routeTwapGuard(address,address) view returns(uint32,uint16,bool)',
    'function setRoute(address,address,bytes)',
    'function setRouteFeeBps(address,address,uint16)',
    'function setRouteTwapGuard(address,address,uint32,uint16)'
  ];
  const safeAbi=[
    'function getOwners() view returns(address[])',
    'function getThreshold() view returns(uint256)',
    'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)'
  ];
  const routerRead=new ethers.Contract(ROUTER,routerAbi,provider);
  assert(lower(await routerRead.owner())===lower(SAFE),'router owner mismatch');
  const safeRead=new ethers.Contract(SAFE,safeAbi,provider);
  const owners=await safeRead.getOwners();
  const threshold=await safeRead.getThreshold();
  assert(threshold===1n && owners.length>0,'Safe ownership/threshold mismatch');
  const owner=owners[0];
  await provider.send('anvil_setBalance',[owner,'0x3635C9ADC5DEA00000']);
  await provider.send('anvil_impersonateAccount',[owner]);
  const safeIface=new ethers.Interface(safeAbi);
  const router=new ethers.Contract(ROUTER,routerAbi,provider);

  const routes=[];
  routes.push(await configureRoute({provider,safeIface,router,owner,tokenIn:FXUSD,tokenOut:VBUSDC,route:FXUSD_TO_VBUSDC,ethers}));
  routes.push(await configureRoute({provider,safeIface,router,owner,tokenIn:VBUSDC,tokenOut:FXUSD,route:VBUSDC_TO_FXUSD,ethers}));
  routes.push(await configureRoute({provider,safeIface,router,owner,tokenIn:VBUSDC,tokenOut:VBWBTC,route:VBUSDC_TO_VBWBTC,ethers}));
  return {safe:SAFE,owner,threshold:Number(threshold),targetPool:pool,routes};
}

async function fund(provider, ethers, amount) {
  const token=new ethers.Contract(VBWBTC,['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)'],provider);
  const before=await token.balanceOf(FUNDING_ACCOUNT);
  assert(before>=amount,'funding account lacks vbWBTC');
  await provider.send('anvil_setBalance',[FUNDING_ACCOUNT,'0x3635C9ADC5DEA00000']);
  await provider.send('anvil_impersonateAccount',[FUNDING_ACCOUNT]);
  const tokenIface=new ethers.Interface(['function transfer(address,uint256) returns(bool)']);
  const hash=await provider.send('eth_sendTransaction',[{
    from:FUNDING_ACCOUNT,
    to:VBWBTC,
    data:tokenIface.encodeFunctionData('transfer',[DEV_ADDRESS,amount]),
    gas:ethers.toQuantity(500_000n)
  }]);
  const receipt=await provider.waitForTransaction(hash);
  assert(receipt && receipt.status===1,'funding transfer failed');
  const after=await token.balanceOf(DEV_ADDRESS);
  assert(after>=amount,'deployer not funded');
  return {source:FUNDING_ACCOUNT,sourceBalanceBefore:before.toString(),deployer:DEV_ADDRESS,deployerBalanceAfter:after.toString(),amount:amount.toString()};
}

async function writeFoundryConfig(root) {
  await fs.writeFile(path.join(root,'foundry.toml'),[
    '[profile.default]',
    'solc = "0.8.30"',
    'src = "cyvbWBTC/contracts"',
    'script = "cyvbWBTC/script"',
    'test = "cyvbWBTC/test"',
    'out = "out"',
    'libs = ["lib"]',
    'optimizer = true',
    'optimizer_runs = 10000000',
    'evm_version = "cancun"',
    ''
  ].join('\n'));
}

async function main() {
  const args=parseArgs(process.argv);
  const forkUrl=args['fork-url'];
  const smartRoot=path.resolve(args['smart-contracts-root']??'.smart-contracts');
  const outputRoot=path.resolve(args.output??'katana-cyvbwbtc-simulation-v13-output');
  const amount=BigInt(args['deposit-amount']??'200000');
  assert(forkUrl,'--fork-url required');
  await fs.rm(outputRoot,{recursive:true,force:true});
  await fs.mkdir(outputRoot,{recursive:true});

  const summary={schemaVersion:'curveyield-katana-cyvbwbtc-lifecycle-v13',status:'RUNNING',fork:{chainId:747474,mode:'plain-anvil-live-katana-fork'},routeConfiguration:null,funding:null,simulation:null,failures:[]};
  let anvil;
  try {
    const ethers=await import('ethers');
    const rpc='http://127.0.0.1:8545';
    anvil=spawn('anvil',['--fork-url',forkUrl,'--chain-id','747474','--host','127.0.0.1','--port','8545','--auto-impersonate','--silent'],{stdio:['ignore','pipe','pipe']});
    let anvilErr='';
    anvil.stderr.on('data',c=>{anvilErr+=c;});
    const provider=new ethers.JsonRpcProvider(rpc);
    await waitRpc(provider,anvil);

    summary.routeConfiguration=await configureRoutes(provider,ethers);
    summary.funding=await fund(provider,ethers,amount);
    await writeFoundryConfig(smartRoot);

    const sim=await run('forge',[
      'script',
      'cyvbWBTC/script/SimulateCyvbWBTC_v9.s.sol:SimulateCyvbWBTC_v9',
      '--rpc-url',rpc,
      '--broadcast',
      '--slow',
      '-vvvv'
    ],{cwd:smartRoot,env:{PRIVATE_KEY:DEV_PRIVATE_KEY,SIM_DEPOSIT_AMOUNT:amount.toString()}});

    summary.simulation={exitCode:sim.code,stdoutTail:sim.stdout.slice(-30000),stderrTail:sim.stderr.slice(-30000),anvilStderrTail:anvilErr.slice(-12000)};
    assert(sim.code===0,'SimulateCyvbWBTC_v9 failed');
    summary.status='PASS';
  } catch(error) {
    summary.status='FAIL';
    summary.failures.push({message:String(error?.message??error),stack:String(error?.stack??'').slice(0,12000)});
    throw error;
  } finally {
    await fs.writeFile(path.join(outputRoot,'KATANA_CYVBWBTC_LIFECYCLE_RESULT_v13.json'),JSON.stringify(summary,null,2)+'\n');
    if(anvil && anvil.exitCode===null) anvil.kill('SIGTERM');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
