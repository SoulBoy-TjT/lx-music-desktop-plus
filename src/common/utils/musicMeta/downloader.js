const http = require('http')
const https = require('https')
const fs = require('fs')
const fsPromises = fs.promises
const { Transform, Writable } = require('stream')
const { pipeline } = require('stream/promises')
const { httpOverHttp, httpsOverHttp } = require('tunnel')

const DEFAULT_REQUEST_TIMEOUT = 15000
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024

const httpsRxp = /^https:/
const getRequestAgent = (url, proxy) => {
  return proxy ? (httpsRxp.test(url) ? httpsOverHttp : httpOverHttp)({ proxy }) : undefined
}

const sendRequest = (url, proxy) => {
  const urlParse = new URL(url)
  const httpOptions = {
    method: 'get',
    host: urlParse.hostname,
    port: urlParse.port,
    path: urlParse.pathname + urlParse.search,
    agent: getRequestAgent(url, proxy),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
    },
  }

  // console.log(httpOptions)
  return urlParse.protocol === 'https:'
    ? https.request(httpOptions)
    : http.request(httpOptions)
}

module.exports = (url, filePath, proxy, timeout = DEFAULT_REQUEST_TIMEOUT, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES) => {
  return new Promise((resolve, reject) => {
    let settled = false
    let deadlineTimer
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadlineTimer)
      ;(error
        ? fsPromises.rm(filePath, { force: true })
        : Promise.resolve()
      ).catch(() => {}).finally(() => {
        if (error) reject(error)
        else resolve(true)
      })
    }

    let request
    try {
      request = sendRequest(url, proxy)
    } catch (err) {
      finish(err)
      return
    }
    let responseStarted = false
    let responseStream
    deadlineTimer = setTimeout(() => {
      const error = new Error(`Cover request exceeded ${timeout} ms deadline`)
      responseStream?.destroy(error)
      request.destroy(error)
    }, timeout)
    request.once('response', response => {
      responseStarted = true
      responseStream = response
      const isSuccess = response.statusCode === 200 || response.statusCode === 206
      let receivedBytes = 0
      const sizeLimit = new Transform({
        transform(chunk, _encoding, callback) {
          receivedBytes += chunk.length
          if (receivedBytes > maxResponseBytes) {
            callback(new Error(`Cover response exceeded maximum size of ${maxResponseBytes} bytes`))
          } else {
            callback(null, chunk)
          }
        },
      })
      const destination = isSuccess
        ? fs.createWriteStream(filePath)
        : new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        })
      pipeline(response, sizeLimit, destination)
        .then(() => {
          if (!isSuccess) {
            finish(new Error(`Cover request failed with status ${response.statusCode}`))
          } else if (!response.complete) {
            finish(new Error('Cover response ended before completion'))
          } else {
            finish()
          }
        })
        .catch(err => finish(err))
    })
    request.once('error', err => {
      if (!responseStarted) finish(err)
    })
    request.end()
  })
}

// const url = 'https://y.gtimg.cn/music/photo_new/T002R500x500M000000nfgwP0D6qxd.jpg'
// // const url = 'http://p4.music.126.net/-U2K8GKlASCSXK0cRre1gA==/109951163188718762.jpg'
// const picPath = require('path').join(__dirname, 'test.jpg')
// module.exports(url, picPath).then((sucee) => {
//   console.log(sucee)
// })
