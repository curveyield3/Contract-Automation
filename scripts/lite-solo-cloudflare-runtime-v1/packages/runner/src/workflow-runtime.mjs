function normalize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') {
      try { return normalize(value.toJSON()); } catch {}
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/^\d+$/.test(key))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return value;
}

function asBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  throw new Error(`Expected integer amount, received ${value}`);
}

function receiptJson(receipt) {
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: receipt.gasUsed?.toString(),
    contractAddress: receipt.contractAddress ?? null,
    logs: (receipt.logs ?? []).map((log) => ({
      address: log.address,
      topics: [...log.topics],
      data: log.data,
      index: log.index
    }))
  };
}

function resolveReference(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveReference(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveReference(child, context)]));
  }
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  const key = value.slice(1);
  if (key in context.aliases) return context.aliases[key];
  if (key in context.values) return context.values[key];
  if (key in context.snapshots) return context.snapshots[key];
  throw new Error(`Unknown workflow reference: ${value}`);
}

function normalizeLiteralAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : value;
}

function functionKey(functionText, Interface) {
  if (!functionText.trim().startsWith('function ')) return functionText.trim();
  const temporary = new Interface([functionText.trim()]);
  return temporary.fragments[0].format('sighash');
}

function externalAbi(functionText) {
  return [functionText.trim().startsWith('function ') ? functionText.trim() : `function ${functionText.trim()}`];
}

export class WorkflowRuntime {
  constructor({ provider, artifacts, ethers }) {
    this.provider = provider;
    this.artifacts = artifacts;
    this.ethers = ethers;
  }

  async signer(from, context) {
    const resolved = from ? resolveReference(from, context) : context.aliases.account0;
    if (!resolved) throw new Error('No simulated sender is available');
    return this.provider.getSigner(resolved);
  }

  deploymentFor(target, context) {
    if (typeof target === 'string' && target.startsWith('$')) {
      return context.deployments[target.slice(1)] ?? null;
    }
    return null;
  }

  contractFor(step, context, signerOrProvider) {
    const resolvedTarget = resolveReference(step.target, context);
    const target = typeof step.target === 'string' && !step.target.startsWith('$')
      ? normalizeLiteralAddress(resolvedTarget)
      : resolvedTarget;
    const deployment = this.deploymentFor(step.target, context);
    const abi = deployment
      ? this.artifacts.get(deployment.contractName, deployment.sourceName).abi
      : externalAbi(step.function);
    return new this.ethers.Contract(target, abi, signerOrProvider);
  }

  async execute(step, context) {
    switch (step.action) {
      case 'deploy': return this.deploy(step, context);
      case 'call': return this.call(step, context);
      case 'staticCall': return this.staticCall(step, context);
      case 'expectRevert': return this.expectRevert(step, context);
      case 'setBalance': return this.setBalance(step, context);
      case 'transferNative': return this.transferNative(step, context);
      case 'mine': return this.mine(step);
      case 'increaseTime': return this.increaseTime(step);
      case 'snapshot': return this.snapshot(step, context);
      case 'revertSnapshot': return this.revertSnapshot(step, context);
      case 'assertBalance': return this.assertBalance(step, context);
      case 'assertCall': return this.assertCall(step, context);
      default: throw new Error(`Unsupported runtime action: ${step.action}`);
    }
  }

  async deploy(step, context) {
    const artifact = this.artifacts.get(step.contract, step.source);
    if (artifact.bytecode === '0x') throw new Error(`Contract ${step.contract} has empty creation bytecode`);
    if (artifact.bytecode.includes('__$')) throw new Error(`Contract ${step.contract} has unlinked libraries`);
    const signer = await this.signer(step.from, context);
    const factory = new this.ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
    const args = resolveReference(step.args ?? [], context);
    const overrides = step.value === undefined ? {} : { value: asBigInt(resolveReference(step.value, context)) };
    const contract = await factory.deploy(...args, overrides);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    const transaction = contract.deploymentTransaction();
    const receipt = await transaction.wait();
    context.aliases[step.alias] = address;
    context.deployments[step.alias] = {
      address,
      contractName: artifact.contractName,
      sourceName: artifact.sourceName
    };
    return { address, receipt: receiptJson(receipt) };
  }

  async call(step, context) {
    const signer = await this.signer(step.from, context);
    const contract = this.contractFor(step, context, signer);
    const key = functionKey(step.function, this.ethers.Interface);
    const fn = contract.getFunction(key);
    const args = resolveReference(step.args ?? [], context);
    const overrides = step.value === undefined ? {} : { value: asBigInt(resolveReference(step.value, context)) };
    const transaction = await fn.send(...args, overrides);
    const receipt = await transaction.wait();
    const output = { receipt: receiptJson(receipt) };
    if (step.saveAs) context.values[step.saveAs] = transaction.hash;
    return output;
  }

  async staticCall(step, context) {
    const from = step.from ? await this.signer(step.from, context) : this.provider;
    const contract = this.contractFor(step, context, from);
    const key = functionKey(step.function, this.ethers.Interface);
    const value = await contract.getFunction(key).staticCall(...resolveReference(step.args ?? [], context));
    const output = normalize(value);
    if (step.saveAs) context.values[step.saveAs] = output;
    return { value: output };
  }

  async expectRevert(step, context) {
    try {
      const signer = await this.signer(step.from, context);
      const contract = this.contractFor(step, context, signer);
      const key = functionKey(step.function, this.ethers.Interface);
      const fn = contract.getFunction(key);
      const args = resolveReference(step.args ?? [], context);
      if (['view', 'pure'].includes(fn.fragment.stateMutability)) {
        await fn.staticCall(...args);
      } else {
        const overrides = step.value === undefined ? {} : { value: asBigInt(resolveReference(step.value, context)) };
        const transaction = await fn.send(...args, overrides);
        await transaction.wait();
      }
    } catch (cause) {
      const message = [cause.message, cause.shortMessage, cause.reason].filter(Boolean).join(' | ');
      if (step.reason && !message.includes(step.reason)) {
        throw new Error(`Transaction reverted, but reason did not include ${step.reason}: ${message}`);
      }
      return { reverted: true, message };
    }
    throw new Error('Expected transaction to revert, but it succeeded');
  }

  async setBalance(step, context) {
    const account = resolveReference(step.account, context);
    const amount = asBigInt(resolveReference(step.amount, context));
    await this.provider.send('evm_setAccountBalance', [account, this.ethers.toBeHex(amount)]);
    return { account, amount: amount.toString() };
  }

  async transferNative(step, context) {
    const signer = await this.signer(step.from, context);
    const to = resolveReference(step.to, context);
    const amount = asBigInt(resolveReference(step.amount, context));
    const receipt = await (await signer.sendTransaction({ to, value: amount })).wait();
    return { receipt: receiptJson(receipt) };
  }

  async mine(step) {
    const blocks = step.blocks ?? 1;
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 10000) throw new Error('blocks must be 1-10000');
    for (let index = 0; index < blocks; index += 1) await this.provider.send('evm_mine', []);
    return { blocks };
  }

  async increaseTime(step) {
    if (!Number.isInteger(step.seconds) || step.seconds < 0 || step.seconds > 315360000) throw new Error('seconds must be 0-315360000');
    await this.provider.send('evm_increaseTime', [step.seconds]);
    await this.provider.send('evm_mine', []);
    return { seconds: step.seconds };
  }

  async snapshot(step, context) {
    const snapshot = await this.provider.send('evm_snapshot', []);
    context.snapshots[step.alias] = snapshot;
    return { snapshot };
  }

  async revertSnapshot(step, context) {
    const snapshot = resolveReference(step.snapshot, context);
    const reverted = await this.provider.send('evm_revert', [snapshot]);
    if (!reverted) throw new Error(`Snapshot could not be reverted: ${snapshot}`);
    return { snapshot, reverted };
  }

  async assertBalance(step, context) {
    const account = resolveReference(step.account, context);
    const balance = await this.provider.getBalance(account);
    if (step.equals !== undefined && balance !== asBigInt(resolveReference(step.equals, context))) {
      throw new Error(`Balance assertion failed: ${balance} !== ${step.equals}`);
    }
    if (step.min !== undefined && balance < asBigInt(resolveReference(step.min, context))) {
      throw new Error(`Balance assertion failed: ${balance} < ${step.min}`);
    }
    if (step.max !== undefined && balance > asBigInt(resolveReference(step.max, context))) {
      throw new Error(`Balance assertion failed: ${balance} > ${step.max}`);
    }
    return { account, balance: balance.toString() };
  }

  async assertCall(step, context) {
    const output = await this.staticCall(step, context);
    const expected = normalize(resolveReference(step.equals, context));
    if (JSON.stringify(output.value) !== JSON.stringify(expected)) {
      throw new Error(`Call assertion failed: ${JSON.stringify(output.value)} !== ${JSON.stringify(expected)}`);
    }
    return { value: output.value, expected };
  }
}
