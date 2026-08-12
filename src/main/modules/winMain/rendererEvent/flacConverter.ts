import { mainHandle } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import type {
  FlacConversionApplyParams,
  FlacConversionPreview,
  FlacConversionPreviewParams,
  FlacConversionResult,
  FlacConverterCapability,
  FlacConversionPauseState,
  FlacConverterArtistScanParams,
  FlacConverterArtistScanResult,
} from '@common/flacConverter'
import { flacConverterService } from '@main/modules/flacConverter'
import { sendEvent } from '../main'

export default () => {
  flacConverterService.setProgressListener(progress => {
    sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.flac_converter_progress, progress)
  })
  mainHandle<never, FlacConverterCapability>(WIN_MAIN_RENDERER_EVENT_NAME.flac_converter_capability_get, async() => flacConverterService.capability())
  mainHandle<FlacConverterArtistScanParams, FlacConverterArtistScanResult>(WIN_MAIN_RENDERER_EVENT_NAME.flac_converter_artists_scan, async({ params }) => flacConverterService.scanArtistFolders(params))
  mainHandle<FlacConversionPreviewParams, FlacConversionPreview>(WIN_MAIN_RENDERER_EVENT_NAME.flac_converter_preview, async({ params }) => flacConverterService.preview(params))
  mainHandle<FlacConversionApplyParams, FlacConversionResult>(WIN_MAIN_RENDERER_EVENT_NAME.flac_converter_apply, async({ params }) => flacConverterService.convert(params))
  mainHandle<boolean, FlacConversionPauseState>(WIN_MAIN_RENDERER_EVENT_NAME.flac_converter_pause_set, async({ params }) => flacConverterService.setPaused(params))
}
