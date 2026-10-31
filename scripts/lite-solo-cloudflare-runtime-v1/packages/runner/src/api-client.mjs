import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export class RunnerApiClient {
  constructor({ baseUrl, apiKey, fetcher = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${this.apiKey}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let detail = `${response.status}`;
      try { detail = JSON.stringify(await response.json()); } catch {}
      throw new Error(`PreflightSim API request failed: ${detail}`);
    }
    return response;
  }

  async getJob(jobId) {
    return (await this.request(`/internal/v1/jobs/${jobId}`)).json();
  }

  async downloadProject(jobId, destination) {
    const response = await this.request(`/internal/v1/jobs/${jobId}/project`);
    if (!response.body) throw new Error('Project download returned no body');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
  }

  async updateStatus(jobId, status) {
    await this.request(`/internal/v1/jobs/${jobId}/status`, {
      method: 'POST',
      body: JSON.stringify(status)
    });
  }

  async publishResult(jobId, result, html) {
    await this.request(`/internal/v1/jobs/${jobId}/result`, {
      method: 'POST',
      body: JSON.stringify({ result, html })
    });
  }
}
