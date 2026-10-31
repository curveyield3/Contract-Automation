import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { MAX_ARCHIVE_BYTES } from '../../protocol/src/index.mjs';
import { safeProjectPath } from './compiler.mjs';

const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 5000;


export function createArchiveByteGuard({
  counter,
  maxEntryBytes = MAX_EXTRACTED_BYTES,
  maxTotalBytes = MAX_EXTRACTED_BYTES
}) {
  if (!counter || !Number.isFinite(counter.total)) throw new Error('Archive byte counter is required');
  let entryBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
      entryBytes += bytes;
      counter.total += bytes;
      if (entryBytes > maxEntryBytes) {
        callback(new Error(`Archive entry exceeds ${maxEntryBytes} bytes`));
        return;
      }
      if (counter.total > maxTotalBytes) {
        callback(new Error(`Archive exceeds ${maxTotalBytes} extracted bytes`));
        return;
      }
      callback(null, chunk);
    }
  });
}

async function downloadToFile(url, destination, { maxBytes = MAX_ARCHIVE_BYTES, headers = {} } = {}) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${new URL(url).origin}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes`);
  let total = 0;
  const guarded = new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes`);
      controller.enqueue(chunk);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(guarded)),
    createWriteStream(destination, { flags: 'wx' })
  );
  return total;
}

function validateEntryName(name) {
  if (typeof name !== 'string' || name.includes('\0') || path.isAbsolute(name)) {
    throw new Error(`Unsafe archive entry: ${name}`);
  }
  const normalized = name.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Unsafe archive entry: ${name}`);
  }
  return normalized;
}

async function inspectTar(file, strip = 0) {
  const tar = await import('tar');
  let files = 0;
  let total = 0;
  await tar.t({
    file,
    onentry(entry) {
      validateEntryName(entry.path);
      if (entry.type === 'File') {
        files += 1;
        total += Number(entry.size ?? 0);
        if (files > MAX_FILES) throw new Error(`Archive exceeds ${MAX_FILES} files`);
        if (total > MAX_EXTRACTED_BYTES) throw new Error(`Archive exceeds ${MAX_EXTRACTED_BYTES} extracted bytes`);
      }
      if (!['File', 'Directory'].includes(entry.type)) {
        throw new Error(`Unsupported tar entry type: ${entry.type}`);
      }
    }
  });
  if (files === 0) throw new Error('Archive contains no files');
  return { tar, strip };
}

async function extractTar(file, destination, strip = 0) {
  const { tar } = await inspectTar(file, strip);
  await tar.x({
    file,
    cwd: destination,
    strip,
    preservePaths: false,
    strict: true,
    filter(entryPath, entry) {
      validateEntryName(entryPath);
      return ['File', 'Directory'].includes(entry.type);
    }
  });
}

async function extractZip(file, destination) {
  const unzipper = await import('unzipper');
  const archive = await unzipper.Open.file(file);
  let files = 0;
  let total = 0;
  const streamed = { total: 0 };
  for (const entry of archive.files) {
    const name = validateEntryName(entry.path);
    if (entry.type === 'Directory') continue;
    if (entry.type !== 'File') throw new Error(`Unsupported ZIP entry type: ${entry.type}`);
    files += 1;
    total += Number(entry.uncompressedSize ?? 0);
    if (files > MAX_FILES) throw new Error(`Archive exceeds ${MAX_FILES} files`);
    if (total > MAX_EXTRACTED_BYTES) throw new Error(`Archive exceeds ${MAX_EXTRACTED_BYTES} extracted bytes`);
    const target = safeProjectPath(destination, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await pipeline(
      entry.stream(),
      createArchiveByteGuard({ counter: streamed }),
      createWriteStream(target, { flags: 'wx' })
    );
  }
  if (files === 0) throw new Error('Archive contains no files');
}

export async function materializeProject(job, root, apiClient) {
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });

  if (job.project.type === 'inline') {
    for (const [relative, source] of Object.entries(job.project.files)) {
      const target = safeProjectPath(projectRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source, { encoding: 'utf8', flag: 'wx' });
    }
    return projectRoot;
  }

  if (job.project.type === 'github') {
    const [owner, repository] = job.project.repository.split('/');
    const archive = path.join(root, 'project.tar.gz');
    const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tar.gz/${encodeURIComponent(job.project.ref)}`;
    await downloadToFile(url, archive);
    await extractTar(archive, projectRoot, 1);
    return projectRoot;
  }

  const archive = path.join(root, 'project.zip');
  await apiClient.downloadProject(job.jobId, archive);
  const metadata = await fs.stat(archive);
  if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error(`Uploaded archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  await extractZip(archive, projectRoot);
  return projectRoot;
}

export async function materializeOpenZeppelin(version, root) {
  if (!version) return null;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('OpenZeppelin version must be exact');
  const archive = path.join(root, `openzeppelin-${version}.tgz`);
  const destination = path.join(root, 'dependencies', '@openzeppelin', 'contracts');
  await fs.mkdir(destination, { recursive: true });
  const url = `https://registry.npmjs.org/@openzeppelin/contracts/-/contracts-${encodeURIComponent(version)}.tgz`;
  await downloadToFile(url, archive, { maxBytes: 100 * 1024 * 1024 });
  await extractTar(archive, destination, 1);
  return destination;
}
