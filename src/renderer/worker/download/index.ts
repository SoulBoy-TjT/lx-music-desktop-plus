import { exposeWorker } from '../utils/worker'

import * as common from './common'
import * as download from './download'
import * as downloadPublication from './downloadPublication'


console.log('hello download worker')


exposeWorker(Object.assign({}, common, download, downloadPublication))

export type workerDownloadTypes = typeof common &
  typeof download &
  typeof downloadPublication
