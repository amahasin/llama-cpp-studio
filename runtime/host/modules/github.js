// github.js — llama.cpp release metadata through the GitHub REST API (no HTML
// scraping). deps: { exec, config, log }.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const API_PATH = '/repos/ggml-org/llama.cpp'

  function Github(deps) {
    this.deps = deps
    this.exec = deps.exec
  }

  Github.prototype._api = async function (path) {
    const cfg = this.deps.config.get('llamaCpp') || {}
    const base = cfg.githubApiBase || 'https://api.github.com'
    // A personal access token lifts the limit from 60 requests an hour, shared
    // by everything behind one IP, to 5000 for this user. Optional: without one
    // the app works exactly as before, it just has fewer lookups to spend.
    const token = typeof cfg.githubToken === 'string' && cfg.githubToken !== '' ? cfg.githubToken : undefined
    const r = await this.exec.httpGetJson(base + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-llama-cpp-manager',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      secretHeaders: token === undefined ? undefined : { Authorization: 'Bearer ' + token },
      timeoutMs: 30000,
    })
    if (!r.ok) {
      if (r.status === 403 || r.status === 429) {
        return {
          ok: false,
          code: 'GITHUB_RATE_LIMIT',
          message: token === undefined
            ? 'GitHub API rate limit reached. Wait ~1 hour or retry later. (Unauthenticated requests are limited to 60/hour.)'
            : 'GitHub API rate limit reached even with a token. Wait for the window to reset, or check that the token is still valid.',
          remediation: token === undefined
            ? [
              'Wait for the rate-limit window to reset (the response headers tell you when).',
              'Add a GitHub personal access token in Settings to raise the limit to 5000 requests an hour.',
              'Use "Import GGUF" with a model you already have — installing llama.cpp is the only step that needs GitHub.',
            ]
            : [
              'Wait for the rate-limit window to reset (the response headers tell you when).',
              'Check that the token has not expired or been revoked.',
            ],
        }
      }
      return { ok: false, code: r.code || 'GITHUB_API', message: r.message }
    }
    return { ok: true, data: r.data }
  }

  /**
   * Fetch the latest stable release metadata:
   * { tagName, name, publishedAt, htmlUrl, assets: [{name,size,downloadUrl}] }
   */
  Github.prototype.latestRelease = async function () {
    const listRes = await this._api(API_PATH + '/releases?per_page=10')
    if (listRes.ok && Array.isArray(listRes.data) && listRes.data.length > 0) {
      const valid = listRes.data.find((d) => !d.draft && Array.isArray(d.assets) && d.assets.some((a) => {
        const name = String(a.name || '')
        return /^llama-/i.test(name) && /-bin-/i.test(name)
      }))
      if (valid) {
        const assets = (valid.assets || []).map((a) => ({
          name: String(a.name),
          size: Number(a.size) || 0,
          downloadUrl: String(a.browser_download_url || ''),
        }))
        return {
          ok: true,
          data: {
            tagName: String(valid.tag_name || ''),
            name: String(valid.name || ''),
            publishedAt: String(valid.published_at || ''),
            htmlUrl: String(valid.html_url || ''),
            assets,
          },
        }
      }
    }
    const r = await this._api(API_PATH + '/releases/latest')
    if (!r.ok) return r
    const d = r.data
    const assets = (d.assets || []).map((a) => ({
      name: String(a.name),
      size: Number(a.size) || 0,
      downloadUrl: String(a.browser_download_url || ''),
    }))
    return {
      ok: true,
      data: {
        tagName: String(d.tag_name || ''),
        name: String(d.name || ''),
        publishedAt: String(d.published_at || ''),
        htmlUrl: String(d.html_url || ''),
        assets,
      },
    }
  }

  /**
   * Fetch one release by tag — used to recover a companion asset (e.g. the
   * CUDA runtime) for an already-installed build.
   */
  Github.prototype.releaseByTag = async function (tag) {
    const clean = String(tag || '').trim()
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(clean)) {
      return { ok: false, code: 'BAD_TAG', message: 'Invalid release tag "' + tag + '".' }
    }
    const r = await this._api(API_PATH + '/releases/tags/' + clean)
    if (!r.ok) return r
    const d = r.data
    return {
      ok: true,
      data: {
        tagName: String(d.tag_name || ''),
        name: String(d.name || ''),
        publishedAt: String(d.published_at || ''),
        htmlUrl: String(d.html_url || ''),
        assets: (d.assets || []).map((a) => ({
          name: String(a.name),
          size: Number(a.size) || 0,
          downloadUrl: String(a.browser_download_url || ''),
        })),
      },
    }
  }

  /**
   * Fetch a page of recent releases (used by "Check for updates" fallback and
   * when the latest tag is a pre-release the user wants to skip).
   */
  Github.prototype.recentReleases = async function (perPage) {
    const n = util.clamp(perPage || 5, 1, 30)
    const r = await this._api(API_PATH + '/releases?per_page=' + n)
    if (!r.ok) return r
    const list = (r.data || []).map((d) => ({
      tagName: String(d.tag_name || ''),
      name: String(d.name || ''),
      publishedAt: String(d.published_at || ''),
      htmlUrl: String(d.html_url || ''),
      assets: (d.assets || []).map((a) => ({
        name: String(a.name),
        size: Number(a.size) || 0,
        downloadUrl: String(a.browser_download_url || ''),
      })),
    }))
    return { ok: true, data: list }
  }

  LLAMA.modules.push('github')
  LLAMA.github = { Github }
})(globalThis.LLAMA)
