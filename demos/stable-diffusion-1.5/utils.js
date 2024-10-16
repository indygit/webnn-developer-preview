import { AutoTokenizer } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.13.4";

let tokenizers;
document.addEventListener("DOMContentLoaded", async () => {
  let path = "";
  if (
    location.href.toLowerCase().indexOf("github.io") > -1 ||
    location.href.toLowerCase().indexOf("huggingface.co") > -1 ||
    location.href.toLowerCase().indexOf("vercel.app") > -1
  ) {
    path =
      "microsoft/stable-diffusion-v1.5-webnn/resolve/main/tokenizer";
  } else {
    path = "../../demos/stable-diffusion-1.5/models/tokenizer/";
  }

  tokenizers = await AutoTokenizer.from_pretrained(path);
});

export async function getTokenizers(text) {
  const { input_ids } = await tokenizers(text);
  return Array.from(input_ids.data, (number) => Number(number)).flat();
}

export const log = (i) => {
  console.log(i);
  if(getMode()) {
    document.getElementById("status").innerText += `\n[${getTime()}] ${i}`;
  } else {
    document.getElementById("status").innerText += `\n${i}`;
  }
};

export const logError = (i) => {
  console.error(i);
  if(getMode()) {
    document.getElementById("status").innerText += `\n[${getTime()}] ${i}`;
  } else {
    document.getElementById("status").innerText += `\n${i}`;
  }
};

export function generateTensorFillValue(dataType, shape, value) {
  let size = 1;
  shape.forEach((element) => {
    size *= element;
  });
  switch (dataType) {
    case "uint8":
      return new ort.Tensor(
        dataType,
        Uint8Array.from({ length: size }, () => value),
        shape
      );
    case "int8":
      return new ort.Tensor(
        dataType,
        Int8Array.from({ length: size }, () => value),
        shape
      );
    case "uint16":
      return new ort.Tensor(
        dataType,
        Uint16Array.from({ length: size }, () => value),
        shape
      );
    case "int16":
      return new ort.Tensor(
        dataType,
        Int16Array.from({ length: size }, () => value),
        shape
      );
    case "uint32":
      return new ort.Tensor(
        dataType,
        Uint32Array.from({ length: size }, () => value),
        shape
      );
    case "int32":
      return new ort.Tensor(
        dataType,
        Int32Array.from({ length: size }, () => value),
        shape
      );
    case "float16":
      return new ort.Tensor(
        dataType,
        Uint16Array.from({ length: size }, () => value),
        shape
      );
    case "float32":
      return new ort.Tensor(
        dataType,
        Float32Array.from({ length: size }, () => value),
        shape
      );
    case "uint64":
      return new ort.Tensor(
        dataType,
        BigUint64Array.from({ length: size }, () => value),
        shape
      );
    case "int64":
      return new ort.Tensor(
        dataType,
        BigInt64Array.from({ length: size }, () => value),
        shape
      );
  }
  throw new Error(`Input tensor type ${dataType} is unknown`);
}

export function generateTensorFromValues(dataType, shape, values) {
  let size = 1;
  shape.forEach((element) => {
    size *= element;
  });
  //log(`values.byteLength: ${values.byteLength}`;
  //log(`size: ${size}`);
  switch (dataType) {
    case "uint8":
      return new ort.Tensor(dataType, new Uint8Array(values), shape);
    case "int8":
      return new ort.Tensor(dataType, new Int8Array(values), shape);
    case "uint16":
      return new ort.Tensor(dataType, new Uint16Array(values), shape);
    case "int16":
      return new ort.Tensor(dataType, new Int16Array(values), shape);
    case "uint32":
      return new ort.Tensor(dataType, new Uint32Array(values), shape);
    case "int32":
      return new ort.Tensor(dataType, new Int32Array(values), shape);
    case "float16":
      return new ort.Tensor(dataType, new Uint16Array(values), shape);
    case "float32":
      return new ort.Tensor(dataType, new Float32Array(values), shape);
    case "uint64":
      return new ort.Tensor(dataType, new BigUint64Array(values), shape);
    case "int64":
      return new ort.Tensor(dataType, new BigInt64Array(values), shape);
  }
  throw new Error(`Input tensor type ${dataType} is unknown`);
}

export function generateTensorFromBytes(dataType, shape, values) {
  let size = 1;
  shape.forEach((element) => {
    size *= element;
  });

  // Coerce TypedArray to actual byte buffer, to avoid constructor behavior that casts to the target type.
  if (!(values instanceof ArrayBuffer)) {
    values = values.buffer;
  }
  switch (dataType) {
    case "uint8":
      return new ort.Tensor(dataType, new Uint8Array(values), shape);
    case "int8":
      return new ort.Tensor(dataType, new Int8Array(values), shape);
    case "uint16":
      return new ort.Tensor(dataType, new Uint16Array(values), shape);
    case "int16":
      return new ort.Tensor(dataType, new Int16Array(values), shape);
    case "uint32":
      return new ort.Tensor(dataType, new Uint32Array(values), shape);
    case "int32":
      return new ort.Tensor(dataType, new Int32Array(values), shape);
    case "float16":
      return new ort.Tensor(dataType, new Uint16Array(values), shape);
    case "float32":
      return new ort.Tensor(dataType, new Float32Array(values), shape);
    case "uint64":
      return new ort.Tensor(dataType, new BigUint64Array(values), shape);
    case "int64":
      return new ort.Tensor(dataType, new BigInt64Array(values), shape);
  }
  throw new Error(`Input tensor type ${dataType} is unknown`);
}

export function decodeFloat16(binaryValue) /*: float Number*/ {
  "use strict";
  let fraction = binaryValue & 0x03ff;
  let exponent = (binaryValue & 0x7c00) >> 10;
  return (
    (binaryValue >> 15 ? -1 : 1) *
    (exponent
      ? exponent === 0x1f
        ? fraction
          ? NaN
          : Infinity
        : Math.pow(2, exponent - 15) * (1 + fraction / 0x400)
      : 6.103515625e-5 * (fraction / 0x400))
  );
}

// https://stackoverflow.com/questions/32633585/how-do-you-convert-to-half-floats-in-javascript
export function encodeFloat16(floatValue) /*: uint16 Number*/ {
  let floatView = new Float32Array(1);
  let int32View = new Int32Array(floatView.buffer);

  floatView[0] = floatValue;
  let x = int32View[0];

  let bits = (x >> 16) & 0x8000; // Get the sign
  let m = (x >> 12) & 0x07ff; // Keep one extra bit for rounding
  let e = (x >> 23) & 0xff; // Using int is faster here

  // If zero, denormal, or underflowing exponent, then return signed zero.
  if (e < 103) {
    return bits;
  }

  // If NaN, return NaN. If Inf or exponent overflow, return Inf.
  if (e > 142) {
    bits |= 0x7c00;
    // If exponent was 0xff and one mantissa bit was set, it means NaN,
    // not Inf, so make sure we set one mantissa bit too.
    bits |= (e == 255 ? 0 : 1) && x & 0x007fffff;
    return bits;
  }

  // If exponent underflows but not too much, return a denormal
  if (e < 113) {
    m |= 0x0800;
    // Extra rounding may overflow and set mantissa to 0 and exponent to 1, which is okay.
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }

  bits |= ((e - 112) << 10) | (m >> 1);
  // Extra rounding. An overflow will set mantissa to 0 and increment the exponent, which is okay.
  bits += m & 1;
  return bits;
}

export const getQueryValue = (name) => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
};

export const getQueryVariable = (name, defaults) => {
  const query = window.location.search.substring(1);
  let vars = query.split("&");
  for (var i = 0; i < vars.length; i++) {
    let pair = vars[i].split("=");
    if (pair[0] == name) {
      return pair[1];
    }
  }
  return defaults;
};

export const modelPath = () => {
  if (
    location.href.toLowerCase().indexOf("github.io") > -1 ||
    location.href.toLowerCase().indexOf("huggingface.co") > -1 ||
    location.href.toLowerCase().indexOf("vercel.app") > -1
  ) {
    return "https://huggingface.co/microsoft/stable-diffusion-v1.5-webnn/resolve/main/";
  } else {
    return "models/";
  }
};

export const randomNumber = () => {
  // generate 6 digital random number between 100, 000 and 999,999
  return Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000;
};

const padNumber = (num, fill) => {
  let len = ("" + num).length;
  return Array(fill > len ? fill - len + 1 || 0 : 0).join(0) + num;
};

export const getTime = () => {
  let date = new Date(),
    hour = padNumber(date.getHours(), 2),
    min = padNumber(date.getMinutes(), 2),
    sec = padNumber(date.getSeconds(), 2);
  return `${hour}:${min}:${sec}`;
};

export const getMode = () => {
  return (getQueryValue("mode") === "normal") ? false : true;
};

export const getSafetyChecker = () => {
  if(getQueryValue("safetychecker")) {
    return (getQueryValue("safetychecker") === "true") ? true : false; 
  } else {
    return true;
  }
};

export const webNnStatus = async () => {
  let result = {};
  try {
    const context = await navigator.ml.createContext();
    if (context) {
      try {
        const builder = new MLGraphBuilder(context);
        if (builder) {
          result.webnn = true;
          return result;
        } else {
          result.webnn = false;
          return result;
        }
      } catch (e) {
        result.webnn = false;
        result.error = e.message;
        return result;
      }
    } else {
      result.webnn = false;
      return result;
    }
  } catch (ex) {
    result.webnn = false;
    result.error = ex.message;
    return result;
  }
};
