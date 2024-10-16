// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
//
// An example how to run stable diffusion 1.5 with webnn in onnxruntime-web.
//

import * as Utils from "./utils.js";
import { setupORT, showCompatibleChromiumVersion } from '../../assets/js/common_utils.js';

// Configuration...
const pixelWidth = 512;
const pixelHeight = 512;
const latentWidth = pixelWidth / 8;
const latentHeight = pixelHeight / 8;
const latentChannelCount = 4;
const unetBatch = 2;
const unetChannelCount = 4;
const textEmbeddingSequenceLength = 77;
const textEmbeddingSequenceWidth = 768;
const unetIterationCount = 25; // Hard-coded number of samples, since the denoising weight ramp is constant.
let seed = BigInt(123465);
let performanceData = {
  loadtime: {
    textencoder: 0,
    unet: 0,
    vaedecoder: 0,
    sc: 0,
    total: 0,
  },
  modelfetch: {
    textencoder: 0,
    unet: 0,
    vaedecoder: 0,
    sc,
  },
  sessioncreate: {
    textencoder: 0,
    unet: 0,
    vaedecoder: 0,
    sc,
  },
  sessionrun: {
    textencoder: 0,
    unet: [],
    unettotal: 0,
    vaedecoder: 0,
    sc,
    total: 0,
  },
};

// convert Float32Array to Uint16Array
function convertToUint16Array(fp32_array) {
  const fp16_array = new Uint16Array(fp32_array.length);
  for (let i = 0; i < fp16_array.length; i++) {
    fp16_array[i] = toHalf(fp32_array[i]);
  }
  return fp16_array;
}

// ref: http://stackoverflow.com/questions/32633585/how-do-you-convert-to-half-floats-in-javascript
const toHalf = (function () {
  var floatView = new Float32Array(1);
  var int32View = new Int32Array(floatView.buffer);

  /* This method is faster than the OpenEXR implementation (very often
   * used, eg. in Ogre), with the additional benefit of rounding, inspired
   * by James Tursa?s half-precision code. */
  return function toHalf(val) {
    floatView[0] = val;
    var x = int32View[0];

    var bits = (x >> 16) & 0x8000; /* Get the sign */
    var m = (x >> 12) & 0x07ff; /* Keep one extra bit for rounding */
    var e = (x >> 23) & 0xff; /* Using int is faster here */

    /* If zero, or denormal, or exponent underflows too much for a denormal
     * half, return signed zero. */
    if (e < 103) {
      return bits;
    }

    /* If NaN, return NaN. If Inf or exponent overflow, return Inf. */
    if (e > 142) {
      bits |= 0x7c00;
      /* If exponent was 0xff and one mantissa bit was set, it means NaN,
       * not Inf, so make sure we set one mantissa bit too. */
      bits |= (e == 255 ? 0 : 1) && x & 0x007fffff;
      return bits;
    }

    /* If exponent underflows but not too much, return a denormal */
    if (e < 113) {
      m |= 0x0800;
      /* Extra rounding may overflow and set mantissa to 0 and exponent
       * to 1, which is OK. */
      bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
      return bits;
    }

    bits |= ((e - 112) << 10) | (m >> 1);
    /* Extra rounding. An overflow will set mantissa to 0 and increment
     * the exponent, which is OK. */
    bits += m & 1;
    return bits;
  };
})();

function to(promise, errorExt) {
  return promise
    .then(function (data) {
      return [null, data];
    })
    .catch(function (err) {
      if (errorExt) {
        Object.assign(err, errorExt);
      }
      return [err, undefined];
    });
}

function draw_out_image(t) {
  const imageData = t.toImageData({ tensorLayout: "NHWC", format: "RGB" });
  const canvas = document.getElementById(`img_canvas_safety`);
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
}

function resize_image(targetWidth, targetHeight) {
  const canvas = document.getElementById(`img_canvas_test`);
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  let ctx = canvas.getContext("2d");
  let canvas_source = document.getElementById(`canvas`);
  ctx.drawImage(
    canvas_source,
    0,
    0,
    canvas_source.width,
    canvas_source.height,
    0,
    0,
    targetWidth,
    targetHeight
  );
  let imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);

  return imageData;
}

function normalizeImageData(imageData) {
  const mean = [0.48145466, 0.4578275, 0.40821073];
  const std = [0.26862954, 0.26130258, 0.27577711];
  const { data, width, height } = imageData;
  const numPixels = width * height;

  let array = new Float32Array(numPixels * 4).fill(0);

  for (let i = 0; i < numPixels; i++) {
    const offset = i * 4;
    for (let c = 0; c < 3; c++) {
      const normalizedValue = (data[offset + c] / 255 - mean[c]) / std[c];
      // data[offset + c] = Math.round(normalizedValue * 255);
      array[offset + c] = normalizedValue * 255;
    }
  }

  // return imageData;
  return { data: array, width: width, height: height };
}

function get_tensor_from_image(imageData, format) {
  const { data, width, height } = imageData;
  const numPixels = width * height;
  const channels = 3;
  const rearrangedData = new Float32Array(numPixels * channels);
  let destOffset = 0;

  for (let i = 0; i < numPixels; i++) {
    const srcOffset = i * 4;
    const r = data[srcOffset] / 255;
    const g = data[srcOffset + 1] / 255;
    const b = data[srcOffset + 2] / 255;

    if (format === "NCHW") {
      rearrangedData[destOffset] = r;
      rearrangedData[destOffset + numPixels] = g;
      rearrangedData[destOffset + 2 * numPixels] = b;
      destOffset++;
    } else if (format === "NHWC") {
      rearrangedData[destOffset] = r;
      rearrangedData[destOffset + 1] = g;
      rearrangedData[destOffset + 2] = b;
      destOffset += channels;
    } else {
      throw new Error("Invalid format specified.");
    }
  }

  const tensorShape =
    format === "NCHW"
      ? [1, channels, height, width]
      : [1, height, width, channels];
  let tensor = new ort.Tensor(
    "float16",
    convertToUint16Array(rearrangedData),
    tensorShape
  );

  return tensor;
}

let progress = 0;
let fetchProgress = 0;
let textEncoderFetchProgress = 0;
let unetFetchProgress = 0;
let vaeDecoderFetchProgress = 0;
let scFetchProgress = 0;
let textEncoderCompileProgress = 0;
let unetCompileProgress = 0;
let vaeDecoderCompileProgress = 0;
let scCompileProgress = 0;

const updateProgress = () => {
  progress =
  textEncoderFetchProgress +
  unetFetchProgress +
  scFetchProgress +
  vaeDecoderFetchProgress +
  textEncoderCompileProgress +
  unetCompileProgress +
  vaeDecoderCompileProgress +
  scCompileProgress;
}

// Get model via Origin Private File System
async function getModelOPFS(name, url, updateModel) {
  const root = await navigator.storage.getDirectory();
  let fileHandle;

  async function updateFile() {
    const response = await fetch(url);
    const buffer = await readResponse(name, response);
    fileHandle = await root.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(buffer);
    await writable.close();
    return buffer;
  }

  if (updateModel) {
    return await updateFile();
  }

  try {
    fileHandle = await root.getFileHandle(name);
    const blob = await fileHandle.getFile();
    let buffer = await blob.arrayBuffer();
    if (buffer) {

      if(Utils.getSafetyChecker()) {
        if (name == "sd_1.5_text-encoder") {
          textEncoderFetchProgress = 7;
        } else if (name == "sd_1.5_unet") {
          unetFetchProgress = 48;
        } else if (name == "sd_1.5_vae-decoder") {
          vaeDecoderFetchProgress = 3;
        } else if (name == "sd_1.5_safety-checker") {
          scFetchProgress = 12;
        }
      } else {
        if (name == "sd_1.5_text-encoder") {
          textEncoderFetchProgress = 7;
        } else if (name == "sd_1.5_unet") {
          unetFetchProgress = 60;
        } else if (name == "sd_1.5_vae-decoder") {
          vaeDecoderFetchProgress = 3;
        } 
      }

      updateProgress();
      progressBarInner.style.width = progress + "%";

      if (name == "sd_1.5_text-encoder") {
        progressBarLabel.textContent =
          "Loading Text Encoder model · 235MB · " + progress.toFixed(2) + "%";
      } else if (name == "sd_1.5_unet") {
        progressBarLabel.textContent =
          "Loading UNet model · 1.60GB · " + progress.toFixed(2) + "%";
      } else if (name == "sd_1.5_vae-decoder") {
        progressBarLabel.textContent =
          "Loading VAE Decoder model · 94.5MB · " + progress.toFixed(2) + "%";
      } else if (name == "sd_1.5_safety-checker") {
        "Loading Safety Checker model · 580MB · " + progress.toFixed(2) + "%";
      }

      return buffer;
    }
  } catch (e) {
    return await updateFile();
  }
}

async function readResponse(name, response) {
  const contentLength = response.headers.get("Content-Length");
  let total = parseInt(contentLength ?? "0");
  let buffer = new Uint8Array(total);
  let loaded = 0;

  const reader = response.body.getReader();
  async function read() {
    const { done, value } = await reader.read();
    if (done) return;

    let newLoaded = loaded + value.length;
    fetchProgress = (newLoaded / contentLength) * 100;

    if(Utils.getSafetyChecker()) {
      if (name == "sd_1.5_text-encoder") {
        textEncoderFetchProgress = 0.07 * fetchProgress;
      } else if (name == "sd_1.5_unet") {
        unetFetchProgress = 0.48 * fetchProgress;
      } else if (name == "sd_1.5_vae-decoder") {
        vaeDecoderFetchProgress = 0.03 * fetchProgress;
      } else if (name == "sd_1.5_safety-checker") {
        scFetchProgress = 0.12 * fetchProgress;
      } 
    } else {
      if (name == "sd_1.5_text-encoder") {
        textEncoderFetchProgress = 0.07 * fetchProgress;
      } else if (name == "sd_1.5_unet") {
        unetFetchProgress = 0.60 * fetchProgress;
      } else if (name == "sd_1.5_vae-decoder") {
        vaeDecoderFetchProgress = 0.03 * fetchProgress;
      }
    }

    updateProgress();
    progressBarInner.style.width = progress + "%";

    if (name == "sd_1.5_text-encoder") {
      progressBarLabel.textContent =
        "Loading Text Encoder model · 235MB · " + progress.toFixed(2) + "%";
    } else if (name == "sd_1.5_unet") {
      progressBarLabel.textContent =
        "Loading UNet model · 1.60GB · " + progress.toFixed(2) + "%";
    } else if (name == "sd_1.5_vae-decoder") {
      progressBarLabel.textContent =
        "Loading VAE Decoder model · 94.5MB · " + progress.toFixed(2) + "%";
    } else if (name == "sd_1.5_safety-checker") {
      progressBarLabel.textContent =
        "Loading Safety Checker model · 580MB · " + progress.toFixed(2) + "%";
    }

    if (newLoaded > total) {
      total = newLoaded;
      let newBuffer = new Uint8Array(total);
      newBuffer.set(buffer);
      buffer = newBuffer;
    }
    buffer.set(value, loaded);
    loaded = newLoaded;
    return read();
  }

  await read();
  return buffer;
}

Utils.log("[Load] Loading ONNX Runtime");
const progressBarInner = document.getElementById("progress-bar-inner");
const progressBarLabel = document.getElementById("progress-bar-label");
const progressBarInnerInference = document.querySelector(
  "#progress-bar-inner-inference"
);
const progressBarLabelInference = document.querySelector(
  "#progress-bar-label-inference"
);

const startButton = document.getElementById("generate_next_image");
const loadButton = document.getElementById("load_models");
const logOutput = document.getElementById("status");
const positiveInput = document.getElementById("positive_prompt");
const negativeInput = document.getElementById("negative_prompt");
const positiveTokenInfo = document.getElementById("positive_token_info");
const negativeTokenInfo = document.getElementById("negative_token_info");
const error = document.querySelector("#error");
const userSeed = document.querySelector("#user_seed");
const changeSeed = document.querySelector("#change_seed");
const title = document.querySelector("#title");
const data = document.querySelector("#data");
const textEncoderLoad = document.querySelector("#textencoderload");
const textEncoderFetch = document.querySelector("#textencoderfetch");
const textEncoderCreate = document.querySelector("#textencodercreate");
const textEncoderRun = document.querySelector("#textencoderrun");
const unetLoad = document.querySelector("#unetload");
const unetFetch = document.querySelector("#unetfetch");
const unetCreate = document.querySelector("#unetcreate");
const unetRun = document.querySelector("#unetrun");
const vaeDecoderLoad = document.querySelector("#vaedecoderload");
const vaeDecoderFetch = document.querySelector("#vaedecoderfetch");
const vaeDecoderCreate = document.querySelector("#vaedecodercreate");
const vaeDecoderRun = document.querySelector("#vaedecoderrun");
const scTr = document.querySelector("#sc");
const scLoad = document.querySelector("#scload");
const scFetch = document.querySelector("#scfetch");
const scCreate = document.querySelector("#sccreate");
const scRun = document.querySelector("#scrun");
const totalLoad = document.querySelector("#totalload");
const totalRun = document.querySelector("#totalrun");
let inferenceProgress = 0;

loadButton.onclick = async () => {
  progress = 0;
  fetchProgress = 0;
  textEncoderFetchProgress = 0;
  unetFetchProgress = 0;
  vaeDecoderFetchProgress = 0;
  scFetchProgress = 0;
  textEncoderCompileProgress = 0;
  unetCompileProgress = 0;
  vaeDecoderCompileProgress = 0;
  scCompileProgress = 0;

  data.removeAttribute("class");
  data.setAttribute("class", "hide");

  performanceData.loadtime.textencoder = 0;
  performanceData.loadtime.unet = [];
  performanceData.loadtime.vaedecoder = 0;
  performanceData.loadtime.sc = 0;
  performanceData.loadtime.total = 0;

  performanceData.modelfetch.textencoder = 0;
  performanceData.modelfetch.unet = 0;
  performanceData.modelfetch.vaedecoder = 0;
  performanceData.modelfetch.sc = 0;

  performanceData.sessioncreate.textencoder = 0;
  performanceData.sessioncreate.unet = 0;
  performanceData.sessioncreate.vaedecoder = 0;
  performanceData.sessioncreate.sc = 0;

  loadButton.disabled = true;
  startButton.disabled = true;
  await loadStableDiffusion(executionProvider);
  startButton.disabled = false;

  if (performanceData.loadtime.total) {
    textEncoderLoad.innerHTML = performanceData.loadtime.textencoder;
    textEncoderFetch.innerHTML = performanceData.modelfetch.textencoder;
    textEncoderCreate.innerHTML = performanceData.sessioncreate.textencoder;
    textEncoderRun.innerHTML = "-";

    unetLoad.innerHTML = performanceData.loadtime.unet;
    unetFetch.innerHTML = performanceData.modelfetch.unet;
    unetCreate.innerHTML = performanceData.sessioncreate.unet;
    unetRun.innerHTML = "-";

    vaeDecoderLoad.innerHTML = performanceData.loadtime.vaedecoder;
    vaeDecoderFetch.innerHTML = performanceData.modelfetch.vaedecoder;
    vaeDecoderCreate.innerHTML = performanceData.sessioncreate.vaedecoder;
    vaeDecoderRun.innerHTML = "-";

    scLoad.innerHTML = performanceData.loadtime.sc;
    scFetch.innerHTML = performanceData.modelfetch.sc;
    scCreate.innerHTML = performanceData.sessioncreate.sc;
    scRun.innerHTML = "-";

    totalLoad.innerHTML = performanceData.loadtime.total;
    totalRun.innerHTML = "-";
  }

  if(Utils.getMode()) {
    data.setAttribute("class", "show");
  }
};

startButton.onclick = async () => {
  textEncoderRun.innerHTML = "";
  unetRun.innerHTML = "";
  vaeDecoderRun.innerHTML = "";
  scRun.innerHTML = "";
  performanceData.sessionrun.textencoder = 0;
  performanceData.sessionrun.unet = [];
  performanceData.sessionrun.unettotal = 0;
  performanceData.sessionrun.vaedecoder = 0;
  performanceData.sessionrun.sc = 0;
  performanceData.sessionrun.total = 0;

  startButton.disabled = true;
  await generateNextImage();
  inferenceProgress = 0;
};

positiveInput.addEventListener("input", async (e) => {
  const inputValue = e.target.value;
  const ids = await Utils.getTokenizers(inputValue);
  // Max token length is 75.
  const left_tokens_length = 75 - ids.length;
  positiveTokenInfo.innerHTML = `${
    left_tokens_length <= 0 ? 0 : left_tokens_length
  }/75`;
});

negativeInput.addEventListener("input", async (e) => {
  const inputValue = e.target.value;
  const ids = await Utils.getTokenizers(inputValue);
  // Max token length is 75.
  const left_tokens_length = 75 - ids.length;
  negativeTokenInfo.innerHTML = `${
    left_tokens_length <= 0 ? 0 : left_tokens_length
  }/75`;
});

async function getTextTokens() {
  const positiveText = positiveInput.value;
  const negativeText = negativeInput.value;

  // A string like 'a cute magical flying ghost dog, fantasy art, golden color, high quality, highly detailed, elegant, sharp focus, concept art, character concepts, digital painting, mystery, adventure'
  // becomes a 1D tensor of {49406, 320, 2242, 7823, 4610, 7108, 1929, 267, 5267, 794, 267, 3878, 3140, 267, 1400, 3027, ...}
  // padded with blanks (id 49407) up to the maximum sequence length of the text encoder (typically 77).
  // So the text encoder can't really handle more than 75 words (+1 start, +1 stop token),
  // not without some extra tricks anyway like calling it multiple times and combining the embeddings.
  let positive_token_ids = [49406]; // Inits with start token
  let negative_token_ids = [49406];
  const positive_text_ids = await Utils.getTokenizers(positiveText);
  positive_token_ids = positive_token_ids.concat(positive_text_ids);
  if (positive_text_ids.length > textEmbeddingSequenceLength - 2) {
    // Max inputs ids should be 75
    positive_token_ids = positive_token_ids.slice(
      0,
      textEmbeddingSequenceLength - 1
    );
    positive_token_ids.push(49407);
  } else {
    const fillerArray = new Array(
      textEmbeddingSequenceLength - positive_token_ids.length
    ).fill(49407);
    positive_token_ids = positive_token_ids.concat(fillerArray);
  }

  let negative_text_ids = await Utils.getTokenizers(negativeText);
  negative_token_ids = negative_token_ids.concat(negative_text_ids);
  if (negative_text_ids.length > textEmbeddingSequenceLength - 2) {
    negative_token_ids = negative_token_ids.slice(
      0,
      textEmbeddingSequenceLength - 1
    );
    negative_token_ids.push(49407);
  } else {
    const fillerArray = new Array(
      textEmbeddingSequenceLength - negative_token_ids.length
    ).fill(49407);
    negative_token_ids = negative_token_ids.concat(fillerArray);
  }

  const token_ids = positive_token_ids.concat(negative_token_ids);
  return token_ids;
}

Utils.log("[Load] ONNX Runtime loaded");

function convertPlanarFloat16RgbToUint8Rgba(
  input /*Uint16Array*/,
  width,
  height
) {
  let totalPixelCount = width * height;
  let totalOutputBytes = totalPixelCount * 4;

  let redInputOffset = 0;
  let greenInputOffset = redInputOffset + totalPixelCount;
  let blueInputOffset = greenInputOffset + totalPixelCount;

  const rgba = new Uint8ClampedArray(totalOutputBytes);
  for (let i = 0, j = 0; i < totalPixelCount; i++, j += 4) {
    rgba[j + 0] =
      (Utils.decodeFloat16(input[redInputOffset + i]) + 1.0) * (255.0 / 2.0);
    rgba[j + 1] =
      (Utils.decodeFloat16(input[greenInputOffset + i]) + 1.0) * (255.0 / 2.0);
    rgba[j + 2] =
      (Utils.decodeFloat16(input[blueInputOffset + i]) + 1.0) * (255.0 / 2.0);
    rgba[j + 3] = 255;
  }
  return rgba;
}

function convertPlanarUint8RgbToUint8Rgba(
  input /*Uint16Array*/,
  width,
  height
) {
  let totalPixelCount = width * height;
  let totalOutputBytes = totalPixelCount * 4;

  let redInputOffset = 0;
  let greenInputOffset = redInputOffset + totalPixelCount;
  let blueInputOffset = greenInputOffset + totalPixelCount;

  const rgba = new Uint8ClampedArray(totalOutputBytes);
  for (let i = 0, j = 0; i < totalPixelCount; i++, j += 4) {
    let inputValue = input[redInputOffset + i];
    rgba[j + 0] = inputValue;
    rgba[j + 1] = inputValue;
    rgba[j + 2] = inputValue;
    rgba[j + 3] = 255;
  }
  return rgba;
}

function convertPlanarFloat32RgbToUint8Rgba(
  input /*Uint16Array*/,
  width,
  height
) {
  let totalPixelCount = width * height;
  let totalOutputBytes = totalPixelCount * 4;

  let redInputOffset = 0;
  let greenInputOffset = redInputOffset + totalPixelCount;
  let blueInputOffset = greenInputOffset + totalPixelCount;

  const rgba = new Uint8ClampedArray(totalOutputBytes);
  for (let i = 0, j = 0; i < totalPixelCount; i++, j += 4) {
    rgba[j + 0] = (input[redInputOffset + i] + 1.0) * (255.0 / 2.0);
    rgba[j + 1] = (input[greenInputOffset + i] + 1.0) * (255.0 / 2.0);
    rgba[j + 2] = (input[blueInputOffset + i] + 1.0) * (255.0 / 2.0);
    rgba[j + 3] = 255;
  }
  return rgba;
}

async function loadModel(modelName /*:String*/, executionProvider /*:String*/) {
  let modelPath;
  let modelSession;
  let freeDimensionOverrides;
  let modelSize;

  if (modelName == "text-encoder") {
    modelSize = "235MB";
  } else if (modelName == "unet") {
    modelSize = "1.60GB";
  } else if (modelName == "vae-decoder") {
    modelSize = "94.5MB";
  } else if (modelName == "safety-checker") {
    modelSize = "580MB";
  }

  Utils.log(`[Load] Loading model ${modelName} · ${modelSize}`);
  if (modelName == "text-encoder") {
    //  Inputs:
    //    int32 input_ids[batch,sequence]
    //    batch: 2
    //    sequence: 77
    //  Outputs:
    //    float16 last_hidden_state[Addlast_hidden_state_dim_0,Addlast_hidden_state_dim_1,768]
    //    float16 pooler_output[Addlast_hidden_state_dim_0,768] We don't care about this ignorable output.
    //    Addlast_hidden_state_dim_0: 2
    //    Addlast_hidden_state_dim_1: 77
    // modelPath = 'models/Stable-Diffusion-v1.5-text-encoder-float16.onnx';
    modelPath = Utils.modelPath() + "text-encoder.onnx";
    freeDimensionOverrides = {
      batch: unetBatch,
      sequence: textEmbeddingSequenceLength,
    };
  } else if (modelName == "unet") {
    //  Typical shapes (some models may vary, like inpainting have 9 channels or single batch having 1 batch)...
    //
    //  Inputs:
    //    float16 sample[2, 4, 64, 64]
    //    int64 timestep[2]
    //    float16 encoder_hidden_states[2, 77, 768]
    //  Outputs:
    //    float16 out_sample[2, 4, 64, 64]
    modelPath =
      Utils.modelPath() +
      "sd-unet-v1.5-model-b2c4h64w64s77-float16-compute-and-inputs-layernorm.onnx";

    freeDimensionOverrides = {
      batch: unetBatch,
      channels: unetChannelCount,
      height: latentHeight,
      width: latentWidth,
      sequence: textEmbeddingSequenceLength,
      unet_sample_batch: unetBatch,
      unet_sample_channels: unetChannelCount,
      unet_sample_height: latentHeight,
      unet_sample_width: latentWidth,
      unet_time_batch: unetBatch,
      unet_hidden_batch: unetBatch,
      unet_hidden_sequence: textEmbeddingSequenceLength,
    };
  } else if (modelName == "vae-decoder") {
    //  Inputs:
    //    float16 latent_sample[1, 4, 64, 64]
    //  Outputs:
    //    float16 sample[1, 3, 512, 512]
    modelPath =
      Utils.modelPath() +
      "Stable-Diffusion-v1.5-vae-decoder-float16-fp32-instancenorm.onnx";
    freeDimensionOverrides = {
      batch: 1,
      channels: latentChannelCount,
      height: latentHeight,
      width: latentWidth,
    };
  } else if (modelName == "safety-checker") {
    //  Inputs:
    //    float16 clip_input[1, 3, 224, 224]
    //    float16 images[1, 224, 224, 3]
    //  Outputs:
    //    float16 out_images
    //    bool has_nsfw_concepts
    modelPath = Utils.modelPath() + "safety_checker.onnx";
    freeDimensionOverrides = {
      batch: 1,
      channels: 3,
      height: 224,
      width: 224,
    };
  } else {
    throw new Error(`Model ${modelName} is unknown`);
  }

  const options = {
    executionProviders: [
      {
        name: executionProvider,
        deviceType: Utils.getQueryVariable("device", "gpu")
      },
    ],
  };

  if (freeDimensionOverrides != undefined) {
    options.freeDimensionOverrides = freeDimensionOverrides;
  }

  options.logSeverityLevel = 0;

  Utils.log("[Load] Model path = " + modelPath);
  let modelBuffer;

  let fetchStartTime = performance.now();
  modelBuffer = await getModelOPFS(`sd_1.5_${modelName}`, modelPath, false);
  let fetchTime = (performance.now() - fetchStartTime).toFixed(2);

  if (modelName == "text-encoder") {
    performanceData.modelfetch.textencoder = fetchTime;
    updateProgress();
    progressBarLabel.textContent = `Loaded Text Encoder · ${(
      fetchTime / 1000
    ).toFixed(2)}s · ${progress}%`;
    Utils.log(`[Load] Text Encoder loaded · ${(fetchTime / 1000).toFixed(2)}s`);

    progressBarLabel.textContent = `Creating session for Text Encoder · ${progress}%`;
    Utils.log("[Session Create] Beginning text encode");
  } else if (modelName == "unet") {
    performanceData.modelfetch.unet = fetchTime;
    updateProgress();
    progressBarLabel.textContent = `Loaded UNet · ${(fetchTime / 1000).toFixed(
      2
    )}s · ${progress}`;
    Utils.log(`[Load] UNet loaded · ${(fetchTime / 1000).toFixed(2)}s`);

    progressBarLabel.textContent = `Creating session for UNet · ${progress}%`;
    Utils.log("[Session Create] Beginning UNet");
  } else if (modelName == "vae-decoder") {
    performanceData.modelfetch.vaedecoder = fetchTime;
    updateProgress();
    progressBarLabel.textContent = `Loaded VAE Decoder · ${(
      fetchTime / 1000
    ).toFixed(2)}s · 81%`;
    Utils.log(`[Load] VAE Decoder loaded · ${(fetchTime / 1000).toFixed(2)}s`);

    progressBarLabel.textContent = `Creating session for VAE Decoder · ${progress}%`;
    Utils.log("[Session Create] Beginning VAE decode");
  } else if (modelName == "safety-checker") {
    performanceData.modelfetch.sc = fetchTime;
    updateProgress();
    progressBarLabel.textContent = `Loaded Safety Checker · ${(
      fetchTime / 1000
    ).toFixed(2)}s · ${progress}%`;
    Utils.log(
      `[Load] Safety Checker loaded · ${(fetchTime / 1000).toFixed(2)}s`
    );

    progressBarLabel.textContent = `Creating session for Safety Checker · ${progress}%`;
    Utils.log("[Session Create] Beginning Safety Checker");
  }

  let createStartTime = performance.now();
  modelSession = await ort.InferenceSession.create(modelBuffer, options);

  if (modelName == "text-encoder") {
    let textencoderCreateTime = (performance.now() - createStartTime).toFixed(
      2
    );
    performanceData.sessioncreate.textencoder = textencoderCreateTime;
    textEncoderCompileProgress = 3;
    updateProgress();
    if(Utils.getMode()) {
      progressBarLabel.textContent = `Text Encoder session created · ${textencoderCreateTime}ms · ${progress}%`;
      Utils.log(`[Session Create] Text Encoder completed · ${textencoderCreateTime}ms`);
    } else {
      progressBarLabel.textContent = `Text Encoder session created · ${progress}%`;
      Utils.log(`[Session Create] Text Encoder completed`);
    }
  } else if (modelName == "unet") {
    let unetCreateTime = (performance.now() - createStartTime).toFixed(2);
    performanceData.sessioncreate.unet = unetCreateTime;
    if(Utils.getSafetyChecker()) {
      unetCompileProgress = 20;
    } else {
      unetCompileProgress = 25;
    }
    updateProgress();
    if(Utils.getMode()) {  
      progressBarLabel.textContent = `UNet session created · ${unetCreateTime}ms · ${progress}%`;
      Utils.log(`[Session Create] UNet Completed · ${unetCreateTime}ms`);
    } else {
      progressBarLabel.textContent = `UNet session created · ${progress}%`;
      Utils.log(`[Session Create] UNet Completed`);
    }
  } else if (modelName == "vae-decoder") {
    let vaedecoderCreateTime = (performance.now() - createStartTime).toFixed(2);
    performanceData.sessioncreate.vaedecoder = vaedecoderCreateTime;
    vaeDecoderCompileProgress = 2;
    updateProgress();
    if(Utils.getMode()) {  
      progressBarLabel.textContent = `VAE Decoder session created · ${vaedecoderCreateTime}ms · ${progress}%`;
      Utils.log(`[Session Create] VAE Decoder completed · ${vaedecoderCreateTime}ms`);
    } else {
      progressBarLabel.textContent = `VAE Decoder session created · ${progress}%`;
      Utils.log(`[Session Create] VAE Decoder completed`);
    }
  } else if (modelName == "safety-checker") {
    let scCreateTime = (performance.now() - createStartTime).toFixed(2);
    performanceData.sessioncreate.sc = scCreateTime;
    scCompileProgress = 5;
    updateProgress();
    if(Utils.getMode()) {  
      progressBarLabel.textContent = `Safety Checker session created · ${scCreateTime}ms · ${progress}%`;
      Utils.log(`[Session Create] Safety Checker completed · ${scCreateTime}ms`);
    } else {
      progressBarLabel.textContent = `Safety Checker session created · ${progress}%`;
      Utils.log(`[Session Create] Safety Checker completed`);
    }  
  }
  return modelSession;
}

function displayEmptyCanvasPlaceholder() {
  const canvas = document.getElementById("canvas");
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(255, 255, 255, 0.5)";
  context.strokeStyle = "rgba(255, 255, 255, 0.0)";
  context.lineWidth = 0;
  //context.fillRect(0, 0, pixelWidth, pixelHeight);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "300px sans-serif";
  context.fillText("🖼️", canvas.width / 2, canvas.height / 2);
  context.strokeRect(0, 0, pixelWidth, pixelHeight);
}

function displayPlanarRGB(
  planarPixelData /*: Float32Array or Uint16Array as float16 or Uint8Array*/
) {
  const canvas = document.getElementById("canvas");
  const context = canvas.getContext("2d");

  // TODO: See if ORT's toImageData() is flexible enough to handle this instead.
  // It doesn't appear work correctly, just returning all white (shrug, maybe I'm passing the wrong values).
  // https://onnxruntime.ai/docs/api/js/interfaces/Tensor-1.html#toImageData
  // https://github.com/microsoft/onnxruntime/blob/5228332/js/common/lib/tensor-conversion.ts#L33
  // https://github.com/microsoft/onnxruntime/blob/main/js/common/lib/tensor-factory.ts#L147
  //
  // let imageData = planarPixelTensor.toImageData({format: 'RGB', tensorLayout: 'NCHW', norm:{bias: 1, mean: 128}});

  let conversionFunction =
    planarPixelData instanceof Float32Array
      ? convertPlanarFloat32RgbToUint8Rgba
      : planarPixelData instanceof Uint16Array
      ? convertPlanarFloat16RgbToUint8Rgba
      : convertPlanarUint8RgbToUint8Rgba;

  let rgbaPixels = conversionFunction(planarPixelData, pixelWidth, pixelHeight);

  let imageData = new ImageData(rgbaPixels, pixelWidth, pixelHeight);
  context.putImageData(imageData, 0, 0);
}

let textEncoderSession;
let vaeDecoderModelSession;
let unetModelSession;
let scModelSession;

// Hard-coded values for 25 iterations (the standard).
const defaultSigmas /*[25 + 1]*/ = [
  14.614647, 11.435942, 9.076809, 7.3019943, 5.9489183, 4.903778, 4.0860896,
  3.4381795, 2.9183085, 2.495972, 2.1485956, 1.8593576, 1.6155834, 1.407623,
  1.2280698, 1.0711612, 0.9323583, 0.80802417, 0.695151, 0.5911423, 0.49355352,
  0.3997028, 0.30577788, 0.20348993, 0.02916753, 0.0,
];
const defaultTimeSteps /*[25]*/ = [
  999.0, 957.375, 915.75, 874.125, 832.5, 790.875, 749.25, 707.625, 666.0,
  624.375, 582.75, 541.125, 499.5, 457.875, 416.25, 374.625, 333.0, 291.375,
  249.75, 208.125, 166.5, 124.875, 83.25, 41.625, 0.0,
];

async function initializeOnnxRuntime() {
  // Global singletons -_-. Initialize ORT's global singleton.
  ort.env.wasm.numThreads = 1; // 4
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
}

async function loadStableDiffusion(executionProvider) {
  try {
    // Release sessions if load models again.
    if (textEncoderSession) {
      await unetModelSession.release();
      await textEncoderSession.release();
      await vaeDecoderModelSession.release();
      if(Utils.getSafetyChecker()) {
        await scModelSession.release();
      }
    }

    error.removeAttribute("class");
    error.innerHTML = "";

    const unetLoadStartTime = performance.now();
    unetModelSession = await loadModel("unet", executionProvider);
    performanceData.loadtime.unet = (
      performance.now() - unetLoadStartTime
    ).toFixed(2);

    const loadStartTime = performance.now();
    textEncoderSession = await loadModel("text-encoder", executionProvider);
    performanceData.loadtime.textencoder = (
      performance.now() - loadStartTime
    ).toFixed(2);

    const vaeDecoderLoadStartTime = performance.now();
    vaeDecoderModelSession = await loadModel("vae-decoder", executionProvider);
    performanceData.loadtime.vaedecoder = (
      performance.now() - vaeDecoderLoadStartTime
    ).toFixed(2);

    if(Utils.getSafetyChecker()) {
      const scLoadStartTime = performance.now();
      scModelSession = await loadModel("safety-checker", executionProvider);
      performanceData.loadtime.sc = (performance.now() - scLoadStartTime).toFixed(
        2
      );
    }

    progressBarInner.style.width = progress + "%";
    progressBarLabel.textContent =
      "Models loaded and sessions created · " + progress.toFixed(2) + "%";
    const loadTime = performance.now() - loadStartTime;
    if(Utils.getMode()) {
      Utils.log(
        `[Total] Total load time (models load and sessions creation): ${(
          loadTime / 1000
        ).toFixed(2)}s`
      );
    }
    performanceData.loadtime.total = loadTime.toFixed(2);
    startButton.removeAttribute("disabled");
  } catch (e) {
    console.log("Exception: ", e);
    error.setAttribute("class", "error");
    error.innerHTML = e.message;
  }
}

function practRandSimpleFastCounter32(a, b, c, d) {
  // https://pracrand.sourceforge.net/
  // Using this as a substitute for std::minstd_rand instead.
  // (std::linear_congruential_engine<std::uint_fast32_t, 48271, 0, 2147483647>).
  return function () {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    var t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function generateNoise(
  /*out*/ latentSpace /*: Uint16Array*/,
  seed /*: BigInt*/
) {
  // Don't know nearly equivalent to .

  let randomGenerator = practRandSimpleFastCounter32(
    Number(seed >> 0n) & 0xffffffff,
    Number(seed >> 32n) & 0xffffffff,
    Number(seed >> 64n) & 0xffffffff,
    Number(seed >> 96n) & 0xffffffff
  );

  const elementCount = latentSpace.length;
  for (let i = 0; i < elementCount; ++i) {
    const u1 = randomGenerator();
    const u2 = randomGenerator();
    const radius = Math.sqrt(-2.0 * Math.log(u1));
    const theta = 2.0 * Math.PI * u2;
    const standardNormalRand = radius * Math.cos(theta);
    const newValue = standardNormalRand;
    latentSpace[i] = Utils.encodeFloat16(newValue);
  }
}

function prescaleLatentSpace(
  /*inout*/ latentSpace /*: Uint16Array*/,
  initialSigma /*: float*/
) {
  const elementCount = latentSpace.length;
  for (let i = 0; i < elementCount; ++i) {
    latentSpace[i] = Utils.encodeFloat16(
      Utils.decodeFloat16(latentSpace[i]) * initialSigma
    );
  }
}

function scaleLatentSpaceForPrediction(
  /*inout*/ latentSpace /*: Uint16Array*/,
  iterationIndex /*: int*/
) {
  console.assert(iterationIndex < defaultSigmas.length);

  // sample = sample / ((sigma**2 + 1) ** 0.5)
  let sigma = defaultSigmas[iterationIndex];
  let inverseScale = 1 / Math.sqrt(sigma * sigma + 1);

  const elementCount = latentSpace.length;
  for (let i = 0; i < elementCount; ++i) {
    latentSpace[i] = Utils.encodeFloat16(
      Utils.decodeFloat16(latentSpace[i]) * inverseScale
    );
  }
}

// Adjusts the latent space in-place by the predicted noise, weighted for the current iteration.
// This version takes two batches, with the positive prediction in batch 0, negative in batch 1.
function denoiseLatentSpace(
  /*inout*/ latentSpace /*: Uint16Array*/,
  iterationIndex /*: Number*/,
  predictedNoise /*: Uint16Array*/
) {
  console.assert(latentSpace.length === predictedNoise.length);

  const elementCount = latentSpace.length; // Given [2, 4, 64, 64], count of all elements.
  const singleBatchElementCount = elementCount / 2; // Given [2, 4, 64, 64], we want only the first batch.

  // Prompt strength scale.
  const defaultPromptStrengthScale = 7.5;
  const positiveWeight = defaultPromptStrengthScale;
  const negativeWeight = 1 - positiveWeight;

  // Add predicted noise (scaled by current iteration weight) to latents.
  const sigma = defaultSigmas[iterationIndex];
  const sigmaNext = defaultSigmas[iterationIndex + 1];
  const dt = sigmaNext - sigma;

  for (let i = 0; i < singleBatchElementCount; ++i) {
    // Fold 2 batches into one, weighted by positive and negative weights.
    const weightedPredictedNoise =
      Utils.decodeFloat16(predictedNoise[i]) * positiveWeight +
      Utils.decodeFloat16(predictedNoise[i + singleBatchElementCount]) *
        negativeWeight;

    // The full formula:
    //
    //  // 1. Compute predicted original sample from sigma-scaled predicted noise.
    //  float sample = latentSpace[i];
    //  float predictedOriginalSample = sample - sigma * predictedNoiseData[i];
    //
    //  // 2. Convert to an ODE derivative
    //  float derivative = (sample - predictedOriginalSample) / sigma;
    //  float previousSample = sample + derivative * dt;
    //  latentSpace[i] = previousSample;
    //
    // Simplifies to:
    //
    //  updatedSample = sample + ((sample - (sample - sigma * predictedNoiseData[i])) / sigma  * dt);
    //  updatedSample = sample + ((sample - sample + sigma * predictedNoiseData[i]) / sigma  * dt);
    //  updatedSample = sample + ((sigma * predictedNoiseData[i]) / sigma  * dt);
    //  updatedSample = sample + (predictedNoiseData[i] * dt);

    latentSpace[i] = Utils.encodeFloat16(
      Utils.decodeFloat16(latentSpace[i]) + weightedPredictedNoise * dt
    );
  }
}

// Adjusts the latent space in-place by the predicted noise, weighted for the current iteration.
// This version takes two separate predicted noise arrays.
function denoiseLatentSpaceSplitPredictions(
  /*inout*/ latentSpace /*: Uint16Array*/,
  iterationIndex /*: Number*/,
  positivePredictedNoise /*: Uint16Array*/,
  negativePredictedNoise /*: Uint16Array*/
) {
  console.assert(latentSpace.length === positivePredictedNoise.length);
  console.assert(latentSpace.length === negativePredictedNoise.length);

  const elementCount = latentSpace.length; // Given [2, 4, 64, 64], count of all elements.

  // Prompt strength scale.
  const defaultPromptStrengthScale = 7.5;
  const positiveWeight = defaultPromptStrengthScale;
  const negativeWeight = 1 - positiveWeight;

  // Add predicted noise (scaled by current iteration weight) to latents.
  const sigma = defaultSigmas[iterationIndex];
  const sigmaNext = defaultSigmas[iterationIndex + 1];
  const dt = sigmaNext - sigma;

  for (let i = 0; i < elementCount; ++i) {
    // Fold 2 batches into one, weighted by positive and negative weights.
    const weightedPredictedNoise =
      Utils.decodeFloat16(positivePredictedNoise[i]) * positiveWeight +
      Utils.decodeFloat16(negativePredictedNoise[i]) * negativeWeight;

    // The full formula:
    //
    //  // 1. Compute predicted original sample from sigma-scaled predicted noise.
    //  float sample = latentSpace[i];
    //  float predictedOriginalSample = sample - sigma * predictedNoiseData[i];
    //
    //  // 2. Convert to an ODE derivative
    //  float derivative = (sample - predictedOriginalSample) / sigma;
    //  float previousSample = sample + derivative * dt;
    //  latentSpace[i] = previousSample;
    //
    // Simplifies to:
    //
    //  updatedSample = sample + ((sample - (sample - sigma * predictedNoiseData[i])) / sigma  * dt);
    //  updatedSample = sample + ((sample - sample + sigma * predictedNoiseData[i]) / sigma  * dt);
    //  updatedSample = sample + ((sigma * predictedNoiseData[i]) / sigma  * dt);
    //  updatedSample = sample + (predictedNoiseData[i] * dt);

    latentSpace[i] = Utils.encodeFloat16(
      Utils.decodeFloat16(latentSpace[i]) + weightedPredictedNoise * dt
    );
  }
}

function applyVaeScalingFactor(latentSpace /*: Uint16Array as float16*/) {
  const /*float*/ defaultVaeScalingFactor = 0.18215; // Magic constants for default VAE :D (used in Huggingface pipeline).
  const /*float*/ inverseScalingFactor = 1.0 / defaultVaeScalingFactor;
  latentSpace.forEach(
    (e, i, a) =>
      (a[i] = Utils.encodeFloat16(
        Utils.decodeFloat16(e) * inverseScalingFactor
      ))
  );
}

async function executeStableDiffusion() {
  /*: ort.Tensor*/
  // Implicit inputs:
  // - unetModelSession
  // - unetInputs
  // - vaeDecoderInputs
  // - scInputs
  Utils.log("[Session Run] Beginning text encode");
  let token_ids = await getTextTokens();
  const startTextEncoder = performance.now();
  const textEncoderInputs = {
    input_ids: Utils.generateTensorFromValues(
      "int32",
      [unetBatch, textEmbeddingSequenceLength],
      token_ids
    ),
  };
  const textEncoderOutputs = await textEncoderSession.run(textEncoderInputs);

  let textEncoderExecutionTime = (performance.now() - startTextEncoder).toFixed(
    2
  );
  performanceData.sessionrun.textencoder = textEncoderExecutionTime;
  if(Utils.getMode()) {
    Utils.log(
      `[Session Run] Text encode execution time: ${textEncoderExecutionTime}ms`
    );
  } else {
    Utils.log(
      `[Session Run] Text encode completed`
    );
  }

  inferenceProgress += 1;
  progressBarInnerInference.style.width = inferenceProgress + "%";
  progressBarLabelInference.textContent =
    "Text encoded · " + inferenceProgress.toFixed(2) + "%";

  Utils.log("[Session Run] Beginning UNet loop execution for 25 iterations");

  let latentSpace = new Uint16Array(
    latentWidth * latentHeight * unetChannelCount
  );
  generateNoise(/*inout*/ latentSpace, seed);
  // Duplicate the input data, once for each batch (only supports unetBatch == 2).
  latentSpace = new Uint16Array([...latentSpace, ...latentSpace]);

  const latentsTensor = Utils.generateTensorFromBytes(
    "float16",
    [unetBatch, unetChannelCount, latentHeight, latentWidth],
    latentSpace
  );

  const halfLatentElementCount = latentsTensor.size / 2; // Given [2, 4, 64, 64], we want only the first batch.
  let latents = await latentsTensor.getData();
  let halfLatents = latents.subarray(0, halfLatentElementCount); // First batch only.
  prescaleLatentSpace(/*inout*/ halfLatents, defaultSigmas[0]);

  const unetInputs = {
    encoder_hidden_states: Utils.generateTensorFromBytes(
      "float16",
      [unetBatch, textEmbeddingSequenceLength, textEmbeddingSequenceWidth],
      textEncoderOutputs["last_hidden_state"].data
    ),
  };

  const startUnet = performance.now();
  // Repeat unet detection and denosing until convergence (typically 25 iterations).
  for (var i = 0; i < unetIterationCount; ++i) {
    // Update time step.
    let startUnetIteration = performance.now();
    const timeStepValue = BigInt(Math.round(defaultTimeSteps[i])); // Round, because this ridiculous language throws an exception otherwise.
    unetInputs["timestep"] = Utils.generateTensorFillValue(
      "int64",
      [unetBatch],
      timeStepValue
    );

    // Prescale the latent values.
    // Copy first batch to second batch, duplicating latents for positive and negative prompts.
    let nextLatents = latents.slice(0);
    let halfNextLatents = nextLatents.subarray(0, halfLatentElementCount);
    scaleLatentSpaceForPrediction(/*inout*/ halfNextLatents, i);
    nextLatents.copyWithin(halfLatentElementCount, 0, halfLatentElementCount); // Copy lower half to upper half.

    unetInputs["sample"] = Utils.generateTensorFromBytes(
      "float16",
      [unetBatch, unetChannelCount, latentHeight, latentWidth],
      nextLatents
    );
    const unetOutputs = await unetModelSession.run(unetInputs);

    let predictedNoise = new Uint16Array(
      unetOutputs["out_sample"].cpuData.buffer
    );
    denoiseLatentSpace(/*inout*/ latents, i, predictedNoise);

    let time = (performance.now() - startUnetIteration).toFixed(2);
    performanceData.sessionrun.unet.push(time);
    // Utils.log(`UNet loop ${i + 1} execution time: ${time}ms`);

    inferenceProgress += 3.8;
    progressBarInnerInference.style.width = inferenceProgress + "%";
    progressBarLabelInference.textContent = `UNet iteration ${
      i + 1
    } completed · ${inferenceProgress.toFixed(2)}%`;
  }

  let unetExecutionTime = (performance.now() - startUnet).toFixed(2);
  performanceData.sessionrun.unettotal = unetExecutionTime;

  if(Utils.getMode()) {
    Utils.log(`[Session Run] UNet loop execution time: ${unetExecutionTime}ms`);
  } else {
    Utils.log(`[Session Run] UNet loop completed`);
  }

  Utils.log("[Session Run] Beginning VAE decode");
  // Decode from latent space.
  applyVaeScalingFactor(/*inout*/ halfLatents);
  let dimensions = latentsTensor.dims.slice(0);
  dimensions[0] = 1; // Set batch size to 1, ignore the 2nd batch for the negative prediction.

  const startVaeDecoder = performance.now();
  const vaeDecoderInputs = {
    latent_sample: Utils.generateTensorFromBytes(
      "float16",
      dimensions,
      halfLatents.slice(0)
    ),
  };
  const decodedOutputs = await vaeDecoderModelSession.run(vaeDecoderInputs);
  let vaeDecoderExecutionTime = (performance.now() - startVaeDecoder).toFixed(
    2
  );

  if(Utils.getMode()) {
    Utils.log(
      `[Session Run] VAE decode execution time: ${vaeDecoderExecutionTime}ms`
    );
  } else {
    Utils.log(
      `[Session Run] VAE decode completed`
    );
  }
  performanceData.sessionrun.vaedecoder = vaeDecoderExecutionTime;

  if(Utils.getSafetyChecker()) {
    inferenceProgress += 3;
  } else {
    inferenceProgress += 4;
  }
  progressBarInnerInference.style.width = inferenceProgress + "%";
  progressBarLabelInference.textContent =
    "VAE decoded · " + inferenceProgress.toFixed(2) + "%";

  return decodedOutputs["sample"];
}

async function executeStableDiffusionAndDisplayOutput() {
  try {
    error.removeAttribute("class");
    error.innerHTML = "";
    displayEmptyCanvasPlaceholder();

    const executionStartTime = performance.now();
    let rgbPlanarPixels = await executeStableDiffusion();
    const executionTime = performance.now() - executionStartTime;
    performanceData.sessionrun.total = executionTime.toFixed(2);

    displayPlanarRGB(await rgbPlanarPixels.getData());

    if(Utils.getSafetyChecker()) {
      // safety_checker
      let resized_image_data = resize_image(224, 224);
      let normalized_image_data = normalizeImageData(resized_image_data);

      Utils.log("[Session Run] Beginning Safety Checker");
      const startSc = performance.now();
      let safety_checker_feed = {
        "clip_input": get_tensor_from_image(normalized_image_data, "NCHW"),
        "images": get_tensor_from_image(resized_image_data, "NHWC"),
      };
      const { has_nsfw_concepts } = await scModelSession.run(safety_checker_feed);
      // const { out_images, has_nsfw_concepts } = await models.safety_checker.sess.run(safety_checker_feed);
      let scExecutionTime = (performance.now() - startSc).toFixed(
        2
      );
      if(Utils.getMode()) {
        Utils.log(
          `[Session Run] Safety Checker execution time: ${scExecutionTime}ms`
        );
      } else {
        Utils.log(
          `[Session Run] Safety Checker completed`
        );
      }
      performanceData.sessionrun.sc = scExecutionTime;

      inferenceProgress += 1;
      progressBarInnerInference.style.width = inferenceProgress + "%";
      progressBarLabelInference.textContent =
        "Completed Safety Checker · " + inferenceProgress.toFixed(2) + "%";

      let nsfw = false;
      (has_nsfw_concepts.data[0]) ? nsfw = true : nsfw = false;
      Utils.log(`[Session Run] Safety Checker - not safe for work (NSFW) concepts: ${nsfw}`);
      if(has_nsfw_concepts.data[0]) {
        document.querySelector(`#canvas`).setAttribute('class', 'canvas nsfw');
        document.querySelector(`#canvas`).setAttribute('title', 'Not safe for work (NSFW) content');
        document.querySelector(`#nsfw`).innerHTML = 'Not safe for work (NSFW) content';
        document.querySelector(`#nsfw`).setAttribute('class', 'nsfw');
      } else {
        document.querySelector(`#canvas`).setAttribute('class', 'canvas');
        document.querySelector(`#canvas`).setAttribute('title', '');
        document.querySelector(`#nsfw`).setAttribute('class', '');
      }
    } else {
      document.querySelector(`#canvas`).setAttribute('class', 'canvas');
      document.querySelector(`#canvas`).setAttribute('title', '');
      document.querySelector(`#nsfw`).setAttribute('class', '');
    }
  } catch (e) {
    error.setAttribute("class", "error");
    error.innerHTML = e.message;
    console.log("Exception: ", e);
  }
}

async function generateNextImage() {
  await executeStableDiffusionAndDisplayOutput();
  // seed++;
  console.log(seed);
  startButton.disabled = false;

  if (performanceData.sessionrun.total) {
    textEncoderLoad.innerHTML = performanceData.loadtime.textencoder;
    textEncoderFetch.innerHTML = performanceData.modelfetch.textencoder;
    textEncoderCreate.innerHTML = performanceData.sessioncreate.textencoder;
    textEncoderRun.innerHTML = performanceData.sessionrun.textencoder;

    unetLoad.innerHTML = performanceData.loadtime.unet;
    unetFetch.innerHTML = performanceData.modelfetch.unet;
    unetCreate.innerHTML = performanceData.sessioncreate.unet;
    unetRun.innerHTML =
      performanceData.sessionrun.unet.toString().replaceAll(",", " ") +
      "<br/>25 Iterations: " +
      performanceData.sessionrun.unettotal;

    vaeDecoderLoad.innerHTML = performanceData.loadtime.vaedecoder;
    vaeDecoderFetch.innerHTML = performanceData.modelfetch.vaedecoder;
    vaeDecoderCreate.innerHTML = performanceData.sessioncreate.vaedecoder;
    vaeDecoderRun.innerHTML = performanceData.sessionrun.vaedecoder;

    scLoad.innerHTML = performanceData.loadtime.sc;
    scFetch.innerHTML = performanceData.modelfetch.sc;
    scCreate.innerHTML = performanceData.sessioncreate.sc;
    scRun.innerHTML = performanceData.sessionrun.sc;

    totalLoad.innerHTML = performanceData.loadtime.total;
    totalRun.innerHTML = performanceData.sessionrun.total;
  }

  if(Utils.getMode()) {
    data.setAttribute("class", "show");
  }
}

const executionProvider = Utils.getQueryVariable("provider", "webnn");
Utils.log("[Load] Execution Provider: " + executionProvider);

const checkWebNN = async () => {
  let status = document.querySelector("#webnnstatus");
  let info = document.querySelector("#info");
  let webnnStatus = await Utils.webNnStatus();

  if (webnnStatus.webnn) {
    status.setAttribute("class", "green");
    info.innerHTML = "WebNN supported · 8GB available GPU memory required";
    loadButton.disabled = false;
  } else {
    loadButton.disabled = true;
    if (webnnStatus.error) {
      status.setAttribute("class", "red");
      info.innerHTML = `WebNN not supported: ${webnnStatus.error} <a id="webnn_na" href="../../install.html" title="WebNN Installation Guide">Set up WebNN</a>`;
      Utils.logError(`[Error] ${webnnStatus.error}`);
    } else {
      status.setAttribute("class", "red");
      info.innerHTML = "WebNN not supported";
      Utils.logError("[Error] WebNN not supported");
    }
  }

  if (
    Utils.getQueryValue("provider") &&
    Utils.getQueryValue("provider").toLowerCase().indexOf("webgpu") > -1
  ) {
    status.innerHTML = "";
  }
};

const ui = async () => {
  await setupORT('stable-diffusion-1.5', 'dev');
  showCompatibleChromiumVersion('stable-diffusion-1.5');
  if (
    Utils.getQueryValue("provider") &&
    Utils.getQueryValue("provider").toLowerCase().indexOf("webgpu") > -1
  ) {
    title.innerHTML = "WebGPU";
  }
  await checkWebNN();
  initializeOnnxRuntime();
  displayEmptyCanvasPlaceholder();
  if(Utils.getSafetyChecker()) {
    scTr.setAttribute("class", "");
  } else {
    scTr.setAttribute("class", "hide");
  }
};

document.addEventListener("DOMContentLoaded", ui, false);

const updateSeed = () => {
  userSeed.value = Utils.randomNumber();
  seed = BigInt(userSeed.value);
};

changeSeed.addEventListener("click", updateSeed, false);