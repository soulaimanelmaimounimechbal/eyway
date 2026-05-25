// AudioWorkletProcessor that takes mono float32 mic input and posts
// Int16 PCM chunks to the main thread. Assumes the AudioContext was
// created at 24000 Hz so no resampling is needed.
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        const pcm = new Int16Array(channel.length);
        for (let i = 0; i < channel.length; i++) {
          let s = channel[i];
          if (s > 1) s = 1;
          else if (s < -1) s = -1;
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm, [pcm.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
