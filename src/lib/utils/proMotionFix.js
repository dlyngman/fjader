export function startProMotionFix() {
	const el = document.createElement('div');
	el.id = 'promotion-fix';
	el.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 50px;
        height: 50px;
        background: red;
        border-radius: 50%;
        z-index: 99999;
        pointer-events: none;
    `;
	document.body.appendChild(el);

	el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
		duration: 1000,
		iterations: Infinity
	});

	return el;
}

// // src/lib/utils/proMotionFix.js

// let videoElement = null;
// let animationId = null;
// let isActive = false;

// /**
//  * Generate a tiny 120fps video programmatically using MediaRecorder
//  * Then play it back - this gives us a "real" 120fps video source
//  */
// async function create120fpsVideoBlob() {
//   return new Promise((resolve, reject) => {
//     const canvas = document.createElement('canvas');
//     canvas.width = 4;
//     canvas.height = 4;
//     const ctx = canvas.getContext('2d', { alpha: false });

//     // Capture at 120fps
//     const stream = canvas.captureStream(120);

//     const mediaRecorder = new MediaRecorder(stream, {
//       mimeType: 'video/webm;codecs=vp9',
//       videoBitsPerSecond: 100000 // Low bitrate, tiny video
//     });

//     const chunks = [];
//     mediaRecorder.ondataavailable = (e) => chunks.push(e.data);

//     mediaRecorder.onstop = () => {
//       const blob = new Blob(chunks, { type: 'video/webm' });
//       resolve(blob);
//     };

//     mediaRecorder.onerror = reject;

//     // Record 2 seconds of frames
//     let frame = 0;
//     const totalFrames = 240; // 2 seconds at 120fps

//     function recordFrame() {
//       const intensity = (frame % 256);
//       ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
//       ctx.fillRect(0, 0, 4, 4);
//       frame++;

//       if (frame < totalFrames) {
//         // Use setTimeout to try to hit 120fps timing
//         setTimeout(recordFrame, 1000 / 120);
//       } else {
//         mediaRecorder.stop();
//       }
//     }

//     mediaRecorder.start();
//     recordFrame();
//   });
// }

// /**
//  * Alternative: Use a high-framerate CSS animation
//  * that explicitly requests updates at 120Hz
//  */
// function createHighFrequencyAnimation() {
//   const el = document.createElement('div');
//   el.style.cssText = `
//     position: fixed;
//     bottom: 0;
//     right: 0;
//     width: 2px;
//     height: 2px;
//     background: black;
//     opacity: 0.02;
//     pointer-events: none;
//     z-index: 9999;
//     will-change: transform;
//   `;

//   document.body.appendChild(el);

//   // Use Web Animations API with very short duration to force high update rate
//   const animation = el.animate(
//     [
//       { transform: 'translateX(0px)' },
//       { transform: 'translateX(0.1px)' },
//     ],
//     {
//       duration: 8.333, // ~120fps (1000ms / 120 = 8.333ms per frame)
//       iterations: Infinity,
//       easing: 'steps(1)',
//     }
//   );

//   return { element: el, animation };
// }

// /**
//  * Create video and also run a parallel RAF loop that
//  * logs timing to potentially influence scheduler
//  */
// function createVideoWithTimingLoop(fps = 120) {
//   const canvas = document.createElement('canvas');
//   canvas.width = 4;
//   canvas.height = 4;

//   const ctx = canvas.getContext('2d', {
//     alpha: false,
//     desynchronized: true
//   });

//   let frame = 0;
//   let lastLogTime = performance.now();
//   let frameTimes = [];

//   function drawFrame(timestamp) {
//     // Track frame timing
//     frameTimes.push(timestamp);

//     // Cycle intensity
//     const intensity = (frame % 256);
//     ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
//     ctx.fillRect(0, 0, 4, 4);
//     frame++;

//     // Log stats every second
//     if (timestamp - lastLogTime >= 1000) {
//       if (frameTimes.length > 1) {
//         const deltas = [];
//         for (let i = 1; i < frameTimes.length; i++) {
//           deltas.push(frameTimes[i] - frameTimes[i - 1]);
//         }
//         const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
//         const minDelta = Math.min(...deltas);
//         const maxDelta = Math.max(...deltas);
//         const actualFps = 1000 / avgDelta;

//         console.log(`ProMotion fix: RAF ${actualFps.toFixed(1)}fps (frame time: avg=${avgDelta.toFixed(2)}ms, min=${minDelta.toFixed(2)}ms, max=${maxDelta.toFixed(2)}ms)`);
//       }
//       frameTimes = [timestamp];
//       lastLogTime = timestamp;
//     }

//     animationId = requestAnimationFrame(drawFrame);
//   }

//   animationId = requestAnimationFrame(drawFrame);

//   // Capture at requested fps
//   const stream = canvas.captureStream(fps);

//   const video = document.createElement('video');
//   video.srcObject = stream;
//   video.muted = true;
//   video.playsInline = true;

//   video.style.cssText = `
//     position: fixed;
//     bottom: 0;
//     right: 0;
//     width: 4px;
//     height: 4px;
//     opacity: 0.02;
//     pointer-events: none;
//     z-index: 9999;
//   `;

//   return { video, canvas, stream };
// }

// let elements = [];
// let animations = [];

// export function startProMotionFix() {
//   if (isActive || typeof document === 'undefined') return;

//   console.log('ProMotion fix: Starting enhanced 120fps strategy');

//   try {
//     // Strategy 1: Video from canvas stream
//     const { video, canvas, stream } = createVideoWithTimingLoop(120);
//     document.body.appendChild(video);
//     video.play().catch(e => console.warn('Video play failed:', e));
//     elements.push(video);

//     // Strategy 2: High-frequency CSS animation (parallel)
//     const { element, animation } = createHighFrequencyAnimation();
//     elements.push(element);
//     animations.push(animation);

//     // Strategy 3: Monitor via requestVideoFrameCallback
//     if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
//       let vfcTimes = [];
//       let lastVfcLog = performance.now();

//       function onVideoFrame(now, metadata) {
//         vfcTimes.push(now);

//         if (now - lastVfcLog >= 1000) {
//           if (vfcTimes.length > 1) {
//             const deltas = [];
//             for (let i = 1; i < vfcTimes.length; i++) {
//               deltas.push(vfcTimes[i] - vfcTimes[i - 1]);
//             }
//             const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
//             const actualFps = 1000 / avgDelta;
//             console.log(`ProMotion fix: Video frame callback ${actualFps.toFixed(1)}fps`);
//           }
//           vfcTimes = [now];
//           lastVfcLog = now;
//         }

//         video.requestVideoFrameCallback(onVideoFrame);
//       }
//       video.requestVideoFrameCallback(onVideoFrame);
//     }

//     isActive = true;
//     console.log('ProMotion fix: Active with multiple strategies');

//   } catch (error) {
//     console.error('ProMotion fix: Failed', error);
//   }
// }

// export function stopProMotionFix() {
//   if (animationId) {
//     cancelAnimationFrame(animationId);
//     animationId = null;
//   }

//   animations.forEach(a => a?.cancel?.());
//   animations = [];

//   elements.forEach(el => el?.remove?.());
//   elements = [];

//   isActive = false;
//   console.log('ProMotion fix: Stopped');
// }

// export function isProMotionFixActive() {
//   return isActive;
// }
