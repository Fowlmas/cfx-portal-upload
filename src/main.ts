import * as core from '@actions/core'
import puppeteer, { Browser, Page } from 'puppeteer'
import NodeFormData from 'form-data'
import axios from 'axios'

import { createReadStream, statSync } from 'fs'
import { basename } from 'path'
import { ReUploadResponse, SSOResponseBody } from './types'
import {
  deleteIfExists,
  resolveAssetId,
  verifyAuth,
  getEnv,
  getUrl,
  preparePuppeteer,
  zipAsset
} from './utils'

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  Origin: 'https://portal.cfx.re',
  Referer: 'https://portal.cfx.re/'
}

export async function run(): Promise<void> {
  await preparePuppeteer()

  let assetId = core.getInput('assetId')
  let assetName = core.getInput('assetName')

  let zipPath = core.getInput('zipPath')
  const makeZip = core.getInput('makeZip').toLowerCase() === 'true'
  const skipUpload = core.getInput('skipUpload').toLowerCase() === 'true'

  const chunkSize = parseInt(core.getInput('chunkSize'))
  const maxRetries = parseInt(core.getInput('maxRetries'))

  if (isNaN(chunkSize)) {
    core.setFailed('Invalid chunk size. Must be a number.')
    return
  }

  if (isNaN(maxRetries)) {
    core.setFailed('Invalid max retries. Must be a number.')
    return
  }

  if (!assetId && !assetName && !skipUpload) {
    assetName = basename(getEnv('GITHUB_WORKSPACE'))
  }

  if (skipUpload) {
    core.info('Skipping upload ...')
    return
  }

  const version = core.getInput('version')
  const changelog = core.getInput('changelog')

  try {
    zipPath = await getZipPath(assetName, zipPath, makeZip)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
    return
  }

  core.info('Uploading file ...')

  const directCookie = `_t=${core.getInput('cookie')}`
  let cookies: string | null = null

  const directAuthOk = await verifyAuth(directCookie)
  if (directAuthOk) {
    cookies = directCookie
  }

  if (!cookies) {
    // Browser SSO path — upload happens from inside browser context via fetch()
    // so Akamai session binding is preserved (credentials: 'include' uses portal-api cookies)
    const isCI = !!process.env.CI
    const browser = await puppeteer.launch({
      headless: isCI,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        ...(isCI ? [] : ['--window-position=-9999,-9999'])
      ]
    })
    const page = await browser.newPage()
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'plugins', { get: () => Array.from({ length: 5 }, (_, i) => ({ name: `Plugin${i}` })) })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      // @ts-expect-error patching chrome runtime
      window.chrome = { runtime: {} }
    })

    try {
      const redirectUrl = await getRedirectUrl(page, maxRetries)
      await setForumCookie(browser, page)

      await page.goto(redirectUrl, { waitUntil: 'networkidle0' })

      if (!page.url().includes('portal.cfx.re')) {
        throw new Error('Redirect failed. Make sure the provided Cookie is valid.')
      }

      // Prime Akamai bot management session
      const jwtCookieRaw = await browser.cookies()
      const jwtCookie = jwtCookieRaw.find(c => c.name === 'jwt')
      if (jwtCookie) {
        await browser.setCookie({ ...jwtCookie, domain: 'portal-api.cfx.re' })
      }
      await page.goto('https://portal-api.cfx.re/v1/me/assets', { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 3000))

      const jwtCookies = await getCookies(browser)

      if (!assetId && assetName) {
        assetId = await resolveAssetId(assetName, jwtCookies)
      }

      // Navigate to assets list — establishes portal.cfx.re origin context for browser fetch
      await page.goto('https://portal.cfx.re/assets/created-assets', { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {})
      await new Promise(r => setTimeout(r, 3000))

      // Search for asset then click UPLOAD NEW VERSION to initialize upload session context
      await page.focus('input[type="search"], input[placeholder*="asset" i]').catch(() => {})
      await page.keyboard.type(assetName || '')
      await new Promise(r => setTimeout(r, 2000))

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim().includes('UPLOAD NEW VERSION'))
        if (btn) {
          btn.scrollIntoView({ block: 'center', behavior: 'instant' })
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
        }
      })
      await new Promise(r => setTimeout(r, 2000))

      // Upload via browser fetch — credentials:include sends all portal-api session cookies,
      // triggering escrow processing that the API-only path (axios) does not receive
      await uploadFromBrowser(page, zipPath, assetId, assetName, chunkSize, version, changelog)
    } catch (error) {
      if (error instanceof Error) core.setFailed(error.message)
    } finally {
      await browser.close()
    }
    return
  }

  // Direct cookie fallback (axios-based, only if _t cookie auth succeeds)
  try {
    if (assetName && !assetId) {
      assetId = await resolveAssetId(assetName, cookies)
    }
    await uploadZip(zipPath, assetId, assetName, chunkSize, cookies, version, changelog)
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function uploadFromBrowser(
  page: Page,
  zipPath: string,
  assetId: string,
  assetName: string,
  chunkSizeBytes: number,
  version: string,
  changelog: string
): Promise<void> {
  const stats = statSync(zipPath)
  const totalSize = stats.size
  const originalFileName = basename(zipPath)
  const chunkCount = Math.ceil(totalSize / chunkSizeBytes)

  // Start re-upload via browser fetch (credentials:include — browser sends its own portal-api cookies)
  const reuploadResult = await page.evaluate(async (p: {
    assetId: string; assetName: string; chunkCount: number; chunkSize: number;
    totalSize: number; fileName: string; version: string; changelog: string
  }) => {
    const res = await fetch(`https://portal-api.cfx.re/v1/assets/${p.assetId}/re-upload`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: p.assetName || p.fileName,
        chunk_count: p.chunkCount,
        chunk_size: p.chunkSize,
        total_size: p.totalSize,
        original_file_name: p.fileName,
        release_candidate: false,
        version: p.version,
        changelog: p.changelog
      })
    })
    const text = await res.text()
    return { status: res.status, body: text }
  }, { assetId, assetName, chunkCount, chunkSize: chunkSizeBytes, totalSize, fileName: originalFileName, version, changelog })

  if (reuploadResult.status >= 400) {
    throw new Error(`re-upload failed with HTTP ${reuploadResult.status}: ${reuploadResult.body}`)
  }

  const reuploadData: ReUploadResponse = JSON.parse(reuploadResult.body)
  if (reuploadData.errors !== null) {
    throw new Error(`re-upload errors: ${JSON.stringify(reuploadData)}`)
  }

  const uploadAssetId = reuploadData.asset_id
  const versionId = reuploadData.version_id

  // Upload chunks from browser context
  const stream = createReadStream(zipPath, { highWaterMark: chunkSizeBytes })
  let chunkIndex = 0

  for await (const rawChunk of stream) {
    const chunkBase64 = (rawChunk as Buffer).toString('base64')

    const chunkResult = await page.evaluate(async (p: {
      assetId: number; versionId: number; chunkIndex: number; chunkBase64: string
    }) => {
      const binaryStr = atob(p.chunkBase64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

      const form = new FormData()
      form.append('chunk_id', p.chunkIndex.toString())
      form.append('chunk', new Blob([bytes], { type: 'application/octet-stream' }), 'blob')

      const res = await fetch(
        `https://portal-api.cfx.re/v1/assets/${p.assetId}/versions/${p.versionId}/upload-chunk`,
        { method: 'POST', credentials: 'include', body: form }
      )
      return { status: res.status, body: await res.text() }
    }, { assetId: uploadAssetId, versionId, chunkIndex, chunkBase64 })

    if (chunkResult.status >= 400) {
      throw new Error(`Chunk ${chunkIndex} upload failed HTTP ${chunkResult.status}: ${chunkResult.body}`)
    }
    core.info(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)
    chunkIndex++
  }

  // Complete upload from browser context
  const completeResult = await page.evaluate(async (p: { assetId: number; versionId: number }) => {
    const res = await fetch(
      `https://portal-api.cfx.re/v1/assets/${p.assetId}/versions/${p.versionId}/complete-upload`,
      { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    )
    return { status: res.status, body: await res.text() }
  }, { assetId: uploadAssetId, versionId })

  if (completeResult.status >= 400) {
    throw new Error(`complete-upload failed HTTP ${completeResult.status}: ${completeResult.body}`)
  }

  core.info('Upload completed.')
}

async function getRedirectUrl(page: Page, maxRetries: number): Promise<string> {
  let loaded = false
  let attempt = 0
  let redirectUrl = null

  while (!loaded && attempt < maxRetries) {
    try {
      core.info('Navigating to SSO URL ...')

      await page.goto(getUrl('SSO'), { waitUntil: 'networkidle0' })

      core.info('Navigated to SSO URL. Parsing response body ...')

      const responseBody = await page.evaluate(
        () => JSON.parse(document.body.innerText) as SSOResponseBody
      )

      redirectUrl = responseBody.url

      core.info('Redirected to Forum Origin ...')

      const forumUrl = new URL(redirectUrl).origin
      await page.goto(forumUrl)

      loaded = true
    } catch {
      core.info(`Failed to navigate to SSO URL. Retrying in 1 seconds...`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      attempt++
    }
  }

  if (!loaded || redirectUrl == null) {
    throw new Error(
      `Failed to navigate to SSO URL after ${maxRetries} attempts.`
    )
  }

  return redirectUrl
}

async function setForumCookie(browser: Browser, page: Page): Promise<void> {
  core.info('Setting cookies ...')

  await browser.setCookie({
    name: '_t',
    value: core.getInput('cookie'),
    domain: 'forum.cfx.re',
    path: '/',
    expires: -1,
    size: 1,
    httpOnly: true,
    secure: true,
    session: false
  })

  await page.evaluate(() => document.write('Cookie' + document.cookie))

  core.info('Cookies set. Following redirect...')
}

async function getCookies(browser: Browser): Promise<string> {
  const all = await browser.cookies()
  const seen = new Set<string>()
  const deduped = all
    .filter(c =>
      c.domain.includes('portal') ||
      ['jwt', 'refresh-token', 'ak_bmsc', 'bm_sv', 'sso-nonce', 'sso-nonce-sig'].includes(c.name)
    )
    .filter(c => {
      if (seen.has(c.name)) return false
      seen.add(c.name)
      return true
    })
  return deduped.map(c => `${c.name}=${c.value}`).join('; ')
}

async function getZipPath(
  assetName: string,
  zipPath: string,
  makeZip: boolean
): Promise<string> {
  if (zipPath.length > 0) {
    return zipPath
  }

  if (!makeZip) {
    throw new Error(
      'Either zipPath or makeZip must be provided to upload a file.'
    )
  }

  core.info('Creating zip file ...')

  deleteIfExists('.git/')
  deleteIfExists('.github/')
  deleteIfExists('.vscode/')

  return zipAsset(assetName)
}

async function startReupload(
  zipPath: string,
  assetId: string,
  assetName: string,
  chunkSize: number,
  cookies: string,
  version: string,
  changelog: string
): Promise<[number, number]> {
  const stats = statSync(zipPath)
  const totalSize = stats.size
  const originalFileName = basename(zipPath)
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const reuploadUrl = getUrl('REUPLOAD', { id: assetId })
  const requestBody = {
    chunk_count: chunkCount,
    chunk_size: chunkSize,
    name: assetName || originalFileName,
    original_file_name: originalFileName,
    version,
    changelog,
    release_candidate: false,
    total_size: totalSize
  }

  const reUploadResponse = await axios.post<ReUploadResponse>(
    reuploadUrl,
    requestBody,
    {
      headers: { Cookie: cookies, ...BROWSER_HEADERS },
      validateStatus: () => true
    }
  )

  if (reUploadResponse.status >= 400) {
    throw new Error(`REUPLOAD failed with HTTP ${reUploadResponse.status}: ${JSON.stringify(reUploadResponse.data)}`)
  }

  if (reUploadResponse.data.errors !== null) {
    throw new Error(`Failed to re-upload file: ${JSON.stringify(reUploadResponse.data)}`)
  }

  return [reUploadResponse.data.asset_id, reUploadResponse.data.version_id]
}

async function uploadZip(
  zipPath: string,
  assetId: string,
  assetName: string,
  chunkSize: number,
  cookies: string,
  version: string,
  changelog: string
): Promise<void> {
  const [assetIdReupload, versionId] = await startReupload(
    zipPath,
    assetId,
    assetName,
    chunkSize,
    cookies,
    version,
    changelog
  )

  let chunkIndex = 0

  const stats = statSync(zipPath)
  const totalSize = stats.size
  const chunkCount = Math.ceil(totalSize / chunkSize)

  const stream = createReadStream(zipPath, { highWaterMark: chunkSize })

  for await (const chunk of stream) {
    const form = new NodeFormData()
    form.append('chunk_id', chunkIndex)
    form.append('chunk', chunk, {
      filename: 'blob',
      contentType: 'application/octet-stream'
    })

    await axios.post(
      getUrl('UPLOAD_CHUNK', { id: assetIdReupload, version_id: versionId }),
      form,
      {
        headers: {
          ...form.getHeaders(),
          Cookie: cookies,
          ...BROWSER_HEADERS,
          'sec-fetch-dest': 'empty'
        }
      }
    )

    core.info(`Uploaded chunk ${chunkIndex + 1}/${chunkCount}`)

    chunkIndex++
  }

  await completeUpload(assetIdReupload, versionId, cookies)
}

async function completeUpload(
  assetId: number,
  versionId: number,
  cookies: string
): Promise<void> {
  const completeUrl = getUrl('COMPLETE_UPLOAD', { id: assetId, version_id: versionId })

  const res = await axios.post(
    completeUrl,
    {},
    {
      headers: { Cookie: cookies, ...BROWSER_HEADERS },
      validateStatus: () => true
    }
  )

  if (res.status >= 400) {
    throw new Error(`COMPLETE_UPLOAD failed with HTTP ${res.status}: ${JSON.stringify(res.data)}`)
  }

  core.info('Upload completed.')
}
