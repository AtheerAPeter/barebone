import type { MeetingLanguage } from '../shared/types'
import type { ModelFile } from './models'
import type { PocketLanguage } from './speech/pocket-voices'

/**
 * The models a meeting downloads, pinned: Moonshine's speech-to-text from its
 * dated release folders, which it never overwrites (moonshine-model-catalog.cpp,
 * v0.1.5), and Pocket's bundles and voices at fixed Hugging Face revisions.
 * Sizes and SHA-256s were taken from those files on 2026-11-03.
 */

/** Moonshine's model for each meeting language: small where it has one, else tiny. */
export const LISTEN_MODELS: Record<
  MeetingLanguage,
  { dir: string; arch: 'small-streaming' | 'tiny-streaming'; files: ModelFile[] }
> = {
  en: {
    dir: 'small-streaming-en',
    arch: 'small-streaming',
    files: [
      {
        path: 'small-streaming-en/adapter.ort',
        size: 2870368,
        sha256: 'c665f742364febad597cc9ac1e0b341ffbee0e24a1466e2f3bde95e6e4771762',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/adapter.ort'
      },
      {
        path: 'small-streaming-en/cross_kv.ort',
        size: 5356536,
        sha256: 'e2d3417144e9514055ebfefe8dcc4c0a55a55adcb8530435844c75c53e352bf6',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/cross_kv.ort'
      },
      {
        path: 'small-streaming-en/decoder_kv.ort',
        size: 81878600,
        sha256: '1a05465b1dd955858dfcbee039c0020fb5dd982b0f5094c34e61735d518d771b',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/decoder_kv.ort'
      },
      {
        path: 'small-streaming-en/encoder.ort',
        size: 44148576,
        sha256: '2d4d973e91e8aca08c51e7e7efa28a46ab265b63d809d5294d18b86bcd85b993',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/encoder.ort'
      },
      {
        path: 'small-streaming-en/frontend.model.ort',
        size: 26944,
        sha256: '09b1210ae30dc5f0f3e45f0ebab914c254741323114f53fbbe5ae62cca35058f',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/frontend.model.ort'
      },
      {
        path: 'small-streaming-en/frontend.weights.ort',
        size: 7769464,
        sha256: '7ef97521bd4bad3928f5bb6808586f4fcc6e92bd5990394112eed7d4052ec338',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/frontend.weights.ort'
      },
      {
        path: 'small-streaming-en/streaming_config.json',
        size: 512,
        sha256: '26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/streaming_config.json'
      },
      {
        path: 'small-streaming-en/tokenizer.bin',
        size: 249974,
        sha256: '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
        url: 'https://download.moonshine.ai/model/small-streaming-en/quantized_26_08_21/tokenizer.bin'
      }
    ]
  },
  de: {
    dir: 'small-streaming-de',
    arch: 'small-streaming',
    files: [
      {
        path: 'small-streaming-de/adapter.ort',
        size: 2869296,
        sha256: 'be438a3eb12ba3697a9e474d20f899e52d8e27b43a6fc4c4c809d2a099646744',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/adapter.ort'
      },
      {
        path: 'small-streaming-de/cross_kv.ort',
        size: 5358752,
        sha256: '0c329cbf001bebbb9e34835e95676b9eb29e010405da46f65af511b8da16620e',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/cross_kv.ort'
      },
      {
        path: 'small-streaming-de/decoder_kv.ort',
        size: 61314512,
        sha256: '7da8ac9a1da2a486158ccde88c756fd876bf7f11ef1c2ba14b80e8edcd30028c',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/decoder_kv.ort'
      },
      {
        path: 'small-streaming-de/encoder.ort',
        size: 44358376,
        sha256: 'f31ef482f940e23af87906aeec986bf2e0a4862cad577bbc745264caab5a1858',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/encoder.ort'
      },
      {
        path: 'small-streaming-de/frontend.model.ort',
        size: 26776,
        sha256: 'a93453223d93aa41d21691568cde3a01125fe00710a5f7004a825e1a322d3025',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/frontend.model.ort'
      },
      {
        path: 'small-streaming-de/frontend.weights.ort',
        size: 7769280,
        sha256: '8b417e2e0ee762e34d7163d24383823bb8bd1d037fb6966c32b3f86a3de4961f',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/frontend.weights.ort'
      },
      {
        path: 'small-streaming-de/streaming_config.json',
        size: 512,
        sha256: '12d16c7f5ea6734d197b79baf47914ea7e996d6fca8d303a19aca10d0617cecc',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/streaming_config.json'
      },
      {
        path: 'small-streaming-de/tokenizer.bin',
        size: 103319,
        sha256: '5725ad3771a1339802f8cebeda0fa8f7723f5282b1ee726c2544774d7399b9a7',
        url: 'https://download.moonshine.ai/model/small-streaming-de/quantized_26_08_24/tokenizer.bin'
      }
    ]
  },
  es: {
    dir: 'small-streaming-es',
    arch: 'small-streaming',
    files: [
      {
        path: 'small-streaming-es/adapter.ort',
        size: 2869296,
        sha256: '04b54114c8aab534222922640f7ca0882948ff9f6ed76777f6e184e55a8e8b15',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/adapter.ort'
      },
      {
        path: 'small-streaming-es/cross_kv.ort',
        size: 5358752,
        sha256: '4bfd0a641d72ccdae22751f86bbb2e25ff70c1fba4f81213f2415a1accff9618',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/cross_kv.ort'
      },
      {
        path: 'small-streaming-es/decoder_kv.ort',
        size: 61314512,
        sha256: '5b77c3d6baf801ef925a5bc54d7eb3db0c35ebbb86f8eaf5390d7f5bb42fef37',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/decoder_kv.ort'
      },
      {
        path: 'small-streaming-es/encoder.ort',
        size: 44358376,
        sha256: 'a9b8d6d5d9348d0e319cceffdb0196ef622df8e4e9f3fb4797dcd8dfafd50857',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/encoder.ort'
      },
      {
        path: 'small-streaming-es/frontend.model.ort',
        size: 26776,
        sha256: '69c76287f49db365aa278d4908ec450e69ca1b4bfb7e836159d963d623ee0c13',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/frontend.model.ort'
      },
      {
        path: 'small-streaming-es/frontend.weights.ort',
        size: 7769280,
        sha256: '2f5a0eb5f3004c9447810d74274a352746319a32144e31d95ef410f425b84dda',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/frontend.weights.ort'
      },
      {
        path: 'small-streaming-es/streaming_config.json',
        size: 512,
        sha256: '12d16c7f5ea6734d197b79baf47914ea7e996d6fca8d303a19aca10d0617cecc',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/streaming_config.json'
      },
      {
        path: 'small-streaming-es/tokenizer.bin',
        size: 102888,
        sha256: '5fbb7d4314dcb18e03c5f975609e4a4cd572b22b01d2b2accb1b3e6830696f36',
        url: 'https://download.moonshine.ai/model/small-streaming-es/quantized_26_08_24/tokenizer.bin'
      }
    ]
  },
  ja: {
    dir: 'small-streaming-ja',
    arch: 'small-streaming',
    files: [
      {
        path: 'small-streaming-ja/adapter.ort',
        size: 2869296,
        sha256: 'edcf20b9d0bc0a92bc0ddf37d8b96599de35a6cbee970368ed74c774b055e546',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/adapter.ort'
      },
      {
        path: 'small-streaming-ja/cross_kv.ort',
        size: 5358752,
        sha256: 'fbd18ec7b9514391d7121f4d4abec1be05a60e94a0f174061428380bf772c3e7',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/cross_kv.ort'
      },
      {
        path: 'small-streaming-ja/decoder_kv.ort',
        size: 61314512,
        sha256: '1246d81eeb96df05d0163dcd48ce271a061b01aa3aea047239fbde22485248be',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/decoder_kv.ort'
      },
      {
        path: 'small-streaming-ja/encoder.ort',
        size: 44358376,
        sha256: '1da7cc82cb91d30ad9dc4e338fb80e7a2336b2c8ad634b826419222698fbe3a5',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/encoder.ort'
      },
      {
        path: 'small-streaming-ja/frontend.model.ort',
        size: 31208,
        sha256: 'de65092295f011a39ee569f03d073e3564d94252efd74ebde16d720bcc43e38b',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/frontend.model.ort'
      },
      {
        path: 'small-streaming-ja/frontend.weights.ort',
        size: 7769288,
        sha256: '4e89578a495a6c4dd5632e7acaf2fc38841e6831738c2702ef10f873125a14ec',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/frontend.weights.ort'
      },
      {
        path: 'small-streaming-ja/streaming_config.json',
        size: 512,
        sha256: '12d16c7f5ea6734d197b79baf47914ea7e996d6fca8d303a19aca10d0617cecc',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/streaming_config.json'
      },
      {
        path: 'small-streaming-ja/tokenizer.bin',
        size: 101836,
        sha256: '9f2599f20c3a9b03d79dbe122e443647c6589ce8e5c73e65e5c5d6f73485d5de',
        url: 'https://download.moonshine.ai/model/small-streaming-ja/quantized_26_08_23/tokenizer.bin'
      }
    ]
  },
  ar: {
    dir: 'tiny-streaming-ar',
    arch: 'tiny-streaming',
    files: [
      {
        path: 'tiny-streaming-ar/adapter.ort',
        size: 1318472,
        sha256: '9c1278a338b4ff268fc5741be01446d56ca9cba9ff5f4a75c5e1b2c2e2739361',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/adapter.ort'
      },
      {
        path: 'tiny-streaming-ar/cross_kv.ort',
        size: 1288120,
        sha256: 'e317af289233894f49da429d4561150c2f61ca86c1b9ca91c6edd3fb4fdeecb5',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/cross_kv.ort'
      },
      {
        path: 'tiny-streaming-ar/decoder_kv.ort',
        size: 19717336,
        sha256: '5c9a2bf2d9fc543fd4596b3ab4ab8d09f791aac5682eb1379fd8d59e34237db0',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/decoder_kv.ort'
      },
      {
        path: 'tiny-streaming-ar/encoder.ort',
        size: 7772792,
        sha256: '6785ca9932d59265375249a8f3bc62f8333fb4dee6ab7db8dfd6f1daef66f59e',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/encoder.ort'
      },
      {
        path: 'tiny-streaming-ar/frontend.model.ort',
        size: 23176,
        sha256: '04c552e66efe3f7206d0a69779864f93bf3cfaf2fa595c9ce5101c8e3854a414',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/frontend.model.ort'
      },
      {
        path: 'tiny-streaming-ar/frontend.weights.ort',
        size: 2093280,
        sha256: '6cc4d70efffe757452996574d11065e7dac6a7ff0a9be3e2fec1d0266b062b0e',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/frontend.weights.ort'
      },
      {
        path: 'tiny-streaming-ar/streaming_config.json',
        size: 509,
        sha256: 'd31afd7c2dd5ee9ae3fa232312c5b42cb3e4fe1c6e9c53d885f2bea63023790a',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/streaming_config.json'
      },
      {
        path: 'tiny-streaming-ar/tokenizer.bin',
        size: 135726,
        sha256: '3acea39a89cdf44fa11f10bfdd7d05d9015d901999f8c8fa18988f19dcc6b267',
        url: 'https://download.moonshine.ai/model/tiny-streaming-ar/quantized_26_08_24/tokenizer.bin'
      }
    ]
  },
  vi: {
    dir: 'tiny-streaming-vi',
    arch: 'tiny-streaming',
    files: [
      {
        path: 'tiny-streaming-vi/adapter.ort',
        size: 1318472,
        sha256: '8351344095ce2e7e8dca7a932c102c7976fd5031d9f50946c05fe4e8ea520cab',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/adapter.ort'
      },
      {
        path: 'tiny-streaming-vi/cross_kv.ort',
        size: 1288120,
        sha256: '0a245cc6b617f9c3a2aebe3ba5e4e12dc6118750fb7e478ccb95fe629abe56cf',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/cross_kv.ort'
      },
      {
        path: 'tiny-streaming-vi/decoder_kv.ort',
        size: 19717336,
        sha256: 'b398871f7668c667f9853758e1bd5ffb77d1ddf72f90ae73ecd4b1f05b3df1d9',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/decoder_kv.ort'
      },
      {
        path: 'tiny-streaming-vi/encoder.ort',
        size: 7772792,
        sha256: '4774270b09a51af0bc7d7a6f5d687aa832ef6ca049ea965ba0ca23f965f3f3dd',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/encoder.ort'
      },
      {
        path: 'tiny-streaming-vi/frontend.model.ort',
        size: 23176,
        sha256: 'fb8c8ae3cbc72f28e56a6f7577440b4e41e41a86b183d50ebd3d35215b712a7d',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/frontend.model.ort'
      },
      {
        path: 'tiny-streaming-vi/frontend.weights.ort',
        size: 2093280,
        sha256: 'beb51a94a57cb33ea740c23d7841ca2855e39fd9df7468a407dfd5eea471d8ca',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/frontend.weights.ort'
      },
      {
        path: 'tiny-streaming-vi/streaming_config.json',
        size: 509,
        sha256: 'd31afd7c2dd5ee9ae3fa232312c5b42cb3e4fe1c6e9c53d885f2bea63023790a',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/streaming_config.json'
      },
      {
        path: 'tiny-streaming-vi/tokenizer.bin',
        size: 95323,
        sha256: '004723b832413eca43dc95f5c1e14311fa78206f81e6bf99ce0e561c657ab209',
        url: 'https://download.moonshine.ai/model/tiny-streaming-vi/quantized_26_08_24/tokenizer.bin'
      }
    ]
  }
}

/** Pocket's bundle and voice for each language it speaks in meetings (speech/pocket.ts). */
export const POCKET_FILES: Record<PocketLanguage, ModelFile[]> = {
  en: [
    {
      path: 'english_2026-10/bundle.json',
      size: 24381,
      sha256: '08b312561393997f2d06aff2cea9657b511cbab7723391cdc384b7fe731e7f32',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/english_2026-10/bundle.json'
    },
    {
      path: 'english_2026-10/tokenizer.model',
      size: 59339,
      sha256: 'd461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/english_2026-10/tokenizer.model'
    },
    {
      path: 'english_2026-10/text_conditioner.onnx',
      size: 16388343,
      sha256: '3406d572f8976c3d5e631582a09d1020070e8b1ed946ea88f8522c8ccd7e455a',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/english_2026-10/text_conditioner.onnx'
    },
    {
      path: 'english_2026-10/flow_lm_main_int8.onnx',
      size: 76341079,
      sha256: '7ff11f5d6d9910ad55d7f0db3a1e059207b73b70158a80472e69ae95b176b33f',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/english_2026-10/flow_lm_main_int8.onnx'
    },
    {
      path: 'english_2026-10/flow_lm_flow.onnx',
      size: 39097094,
      sha256: 'a689a0d10530719fe729db5ee2c01677a3b2fbecb9cc9d36b8e4aeab8b83f627',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/english_2026-10/flow_lm_flow.onnx'
    },
    {
      path: 'english_2026-10/mimi_decoder.onnx',
      size: 41471925,
      sha256: 'cac8c3e042ed4fbd9a719742fee44b1c735909945528e91c9f1f05d562dd57ec',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/english_2026-10/mimi_decoder.onnx'
    },
    {
      path: 'english_2026-10/charles.safetensors',
      size: 6195000,
      sha256: '007c66f069aa3a564139974e5d4e1e1902ae95d91e76963bee64f4309a75cf8f',
      url: 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/a7056f505a4a8ca72d8b5fb1440071d6f1a35739/languages/english_2026-10/embeddings/charles.safetensors'
    }
  ],
  de: [
    {
      path: 'german/bundle.json',
      size: 24362,
      sha256: '7f032e4df0db3a02e24871dfa496e2b7ffa095dd98640bfcf12c04b8671ac60e',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/german/bundle.json'
    },
    {
      path: 'german/tokenizer.model',
      size: 60347,
      sha256: 'b3d6fb751a0bbc0b18df78687a03c11e4f2fbb0fa4b8f85e83064cd9d80ee34b',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/german/tokenizer.model'
    },
    {
      path: 'german/text_conditioner.onnx',
      size: 16388343,
      sha256: 'c08be1fe8afc6111282d9b5f5dc2d28f9ff7499036e43257139c1e17b26870bd',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/german/text_conditioner.onnx'
    },
    {
      path: 'german/flow_lm_main_int8.onnx',
      size: 76341079,
      sha256: '6f1854a443dafd96773263a420b9dc140083c4ed75d6c55e541c4ab69b7b1790',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/german/flow_lm_main_int8.onnx'
    },
    {
      path: 'german/flow_lm_flow.onnx',
      size: 39097094,
      sha256: 'c350343db74b4f154e3b6ef6e279b25ffd47ca7bf84e129aa1f281c892853644',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/german/flow_lm_flow.onnx'
    },
    {
      path: 'german/mimi_decoder.onnx',
      size: 41471925,
      sha256: '75458731e13c273c240f53237c91921a1094a0fe633608cd6f7d6ba5455630ca',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/german/mimi_decoder.onnx'
    },
    {
      path: 'german/juergen.safetensors',
      size: 6096696,
      sha256: '65104a25b2aa797c50b2cee555cb75deb6abba10169168b95857227a054126d1',
      url: 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/a7056f505a4a8ca72d8b5fb1440071d6f1a35739/languages/german/embeddings/juergen.safetensors'
    }
  ],
  es: [
    {
      path: 'spanish/bundle.json',
      size: 24365,
      sha256: 'c9f18b5fc326c2a99f645588b79ef27ef3c9c6c3066f8df73bccb7f7c1f855b3',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/spanish/bundle.json'
    },
    {
      path: 'spanish/tokenizer.model',
      size: 61063,
      sha256: '9714c8ce180d8147ab4c1406cd759619828f95d7000c87c41dc9ccec527a3e89',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/spanish/tokenizer.model'
    },
    {
      path: 'spanish/text_conditioner.onnx',
      size: 16388343,
      sha256: '536bf4edd3990a643abb9d7a9ec6e072ff53dde8bc2e4d157e7e9d8b4b82cb8f',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/spanish/text_conditioner.onnx'
    },
    {
      path: 'spanish/flow_lm_main_int8.onnx',
      size: 76341079,
      sha256: '6ac12c7e93729bf63262c4c687cc8f475f7218ab41121575bb92a316f77e84c0',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/spanish/flow_lm_main_int8.onnx'
    },
    {
      path: 'spanish/flow_lm_flow.onnx',
      size: 39097094,
      sha256: 'aa69c2e32b709f199ae24d6d3baf7ab000d8365e22d6cd658835b8ce63456fb0',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/spanish/flow_lm_flow.onnx'
    },
    {
      path: 'spanish/mimi_decoder.onnx',
      size: 41471925,
      sha256: 'c5b9175451def9c306a7e0fbffacc1671af0e2adf1f4080d11fa9020b9c03c86',
      url: 'https://huggingface.co/lineofflight/pocket-tts-onnx/resolve/828270feafd9e608eefdb0213c35c27b138a058d/onnx/spanish/mimi_decoder.onnx'
    },
    {
      path: 'spanish/lola.safetensors',
      size: 5457720,
      sha256: '967b8f08639345ff5ad1a912a5542fe421518c3f80b87d52078c6726348ab1e7',
      url: 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/a7056f505a4a8ca72d8b5fb1440071d6f1a35739/languages/spanish/embeddings/lola.safetensors'
    }
  ]
}
