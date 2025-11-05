import { Command } from 'commander'
import * as fs from 'fs'
import * as uuid from 'uuid'
import WebSocket from 'ws'
import {
  MsgType,
  ReceiveMessage,
  EventType,
  FullClientRequest,
} from './protocols'

const program = new Command()

function VoiceToResourceId(voice: string): string {
  if (voice.startsWith('S_')) {
    return 'volc.megatts.default'
  }
  return 'volc.service_type.10029'
}

program
  .name('unidirectional-stream')
  .option('--appid <appid>', 'appid', '')
  .option('--access_token <access_token>', 'access key', '')
  .option('--resource_id <resource_id>', 'resource id', '')
  .option('--voice_type <voice>', 'voice_type', '')
  .option('--text <text>', 'text', '')
  .option('--encoding <encoding>', 'encoding format', 'wav')
  .option(
    '--endpoint <endpoint>',
    'websocket endpoint',
    'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream',
  )
  .action(async (options) => {
    console.log('options: ', options)

    const headers = {
      'X-Api-App-Key': options.appid,
      'X-Api-Access-Key': options.access_token,
      'X-Api-Resource-Id':
        (options.resource_id && options.resource_id.trim()) ||
        VoiceToResourceId(options.voice_type),
      'X-Api-Connect-Id': uuid.v4(),
    }

    const ws = new WebSocket(options.endpoint, {
      headers,
      skipUTF8Validation: true,
    })

    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })

    const request = {
      user: {
        uid: uuid.v4(),
      },
      req_params: {
        speaker: options.voice_type,
        text: options.text,
        audio_params: {
          format: options.encoding,
          sample_rate: 24000,
          enable_timestamp: true,
        },
        additions: JSON.stringify({
          disable_markdown_filter: false,
        }),
      },
    }

    await FullClientRequest(
      ws,
      new TextEncoder().encode(JSON.stringify(request)),
    )

    const totalAudio: Uint8Array[] = []

    while (true) {
      const msg = await ReceiveMessage(ws)
      console.log(`${msg.toString()}`)

      switch (msg.type) {
        case MsgType.FullServerResponse:
          break
        case MsgType.AudioOnlyServer:
          totalAudio.push(msg.payload)
          break
        default:
          throw new Error(`${msg.toString()}`)
      }

      if (
        msg.type === MsgType.FullServerResponse &&
        msg.event === EventType.SessionFinished
      ) {
        break
      }
    }

    if (totalAudio.length === 0) {
      throw new Error('no audio received')
    }

    const outputFile = `${options.voice_type}.${options.encoding}`
    await fs.promises.writeFile(outputFile, totalAudio)
    console.log(`audio saved to ${outputFile}`)

    ws.close()
  })

program.parse()
