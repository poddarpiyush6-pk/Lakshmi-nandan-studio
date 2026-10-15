/*************************************************************************
     * 1. TOOLS CONFIGURATION (Truthfulness over appearance: P0/P1 vs P2)
     *************************************************************************/
    const TOOLS = [
      { id: 'move', label: 'Move & Transform', shortcut: 'V', icon: 'move', available: true },
      { id: 'marquee-rect', label: 'Rectangular Marquee Selection', shortcut: 'M', icon: 'square-dashed', available: true },
      { id: 'marquee-ellipse', label: 'Elliptical Marquee Selection', shortcut: 'E', icon: 'circle-dashed', available: true },
      { id: 'lasso', label: 'Freehand Lasso Selection', shortcut: 'L', icon: 'lasso', available: true },
      { id: 'wand', label: 'Magic Wand (Flood-Fill Selection)', shortcut: 'W', icon: 'wand-2', available: true },
      { id: 'brush', label: 'Paint Brush Tool', shortcut: 'B', icon: 'brush', available: true },
      { id: 'eraser', label: 'Pixel Eraser Tool', shortcut: 'X', icon: 'eraser', available: true },
      { id: 'text', label: 'Horizontal Type Tool', shortcut: 'T', icon: 'type', available: true },
      { id: 'shape', label: 'Rectangle Vector Shape', shortcut: 'U', icon: 'square', available: true },
      { id: 'hand', label: 'Hand Tool (Pan Viewport)', shortcut: 'H', icon: 'hand', available: true },
      { id: 'zoom', label: 'Zoom Viewport Tool', shortcut: 'Z', icon: 'zoom-in', available: true },
      { id: 'clone', label: 'Clone Stamp', shortcut: 'S', icon: 'stamp', available: false, reason: 'Planned for Phase 3 P1 Gate' },
      { id: 'ai-fill', label: 'AI Generative Fill', shortcut: 'G', icon: 'sparkles', available: false, reason: 'Image-to-image fill is not implemented' }
    ];

    /*************************************************************************
     * 2. BINARY ASSET STORE & DOCUMENT STATE MODEL
     *************************************************************************/
    const AssetStore = new Map(); // id -> HTMLCanvasElement (holds lossless pixel / mask data)

    function createOffscreenCanvas(w, h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }

    function cloneCanvas(src) {
      const c = createOffscreenCanvas(src.width, src.height);
      c.getContext('2d').drawImage(src, 0, 0);
      return c;
    }

    let state = {
      doc: {
        id: 'doc-initial',
        name: 'Untitled-1',
        schemaVersion: 1,
        width: 1280,
        height: 720,
        background: '#ffffff',
        layers: [] // bottom-to-top array
      },
      selectedLayerId: null,
      activeTool: 'move',
      viewport: { panX: 60, panY: 45, zoom: 0.75 },
      brush: { color: '#0ea5e9', size: 28, hardness: 0.85, opacity: 1.0, paintMask: false },
      wandTolerance: 32,
      selectionMask: null, // Uint8Array (width * height), 255 = selected, 0 = unselected
      hasSelection: false
    };

    /*************************************************************************
     * 3. SNAPSHOT COMMAND HISTORY (Exact Undo/Redo for Every Tool & Pixel Edit)
     *************************************************************************/
    const History = {
      undoStack: [],
      redoStack: [],
      maxEntries: 30,

      captureSnapshot(label) {
        const assetClones = new Map();
        for (const [k, canvas] of AssetStore.entries()) {
          assetClones.set(k, cloneCanvas(canvas));
        }
        return {
          label,
          docJson: JSON.stringify(state.doc),
          selectedLayerId: state.selectedLayerId,
          selectionMask: state.selectionMask ? new Uint8Array(state.selectionMask) : null,
          hasSelection: state.hasSelection,
          assets: assetClones
        };
      },

      pushBeforeState(snapshot) {
        this.undoStack.push(snapshot);
        if (this.undoStack.length > this.maxEntries) this.undoStack.shift();
        this.redoStack = [];
        updateHistoryUI();
        triggerIndexedDBAutosave();
      },

      restoreSnapshot(snap) {
        state.doc = JSON.parse(snap.docJson);
        state.selectedLayerId = snap.selectedLayerId;
        state.selectionMask = snap.selectionMask ? new Uint8Array(snap.selectionMask) : null;
        state.hasSelection = snap.hasSelection;
        AssetStore.clear();
        for (const [k, c] of snap.assets.entries()) {
          AssetStore.set(k, cloneCanvas(c));
        }
        renderAll();
        updateHistoryUI();
      },

      undo() {
        if (this.undoStack.length === 0) return;
        const currentSnap = this.captureSnapshot('Current');
        const prev = this.undoStack.pop();
        this.redoStack.push(currentSnap);
        this.restoreSnapshot(prev);
      },

      redo() {
        if (this.redoStack.length === 0) return;
        const currentSnap = this.captureSnapshot('Current');
        const next = this.redoStack.pop();
        this.undoStack.push(currentSnap);
        this.restoreSnapshot(next);
      }
    };

    /*************************************************************************
     * 4. SECURITY & FILE SIGNATURE VALIDATION (Section 11 & Journey 9)
     *************************************************************************/
    function validateFileSignature(bytes) {
      if (!bytes || bytes.byteLength === 0) {
        return { valid: false, error: 'Rejected: File is empty (0 bytes).' };
      }
      if (bytes.byteLength > 50 * 1024 * 1024) {
        return { valid: false, error: 'Rejected: File exceeds 50 MB limit.' };
      }
      if (bytes.byteLength < 12) {
        return { valid: false, error: 'Rejected: Corrupt or truncated file header.' };
      }
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return { valid: true, mime: 'image/png' };
      }
      // JPEG: FF D8 FF
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { valid: true, mime: 'image/jpeg' };
      }
      // WebP: RIFF....WEBP
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { valid: true, mime: 'image/webp' };
      }
      return {
        valid: false,
        error: 'Unsupported or corrupt file signature! Only verified PNG, JPEG, and WebP headers are permitted.'
      };
    }

    function showBanner(msg, isError = true) {
      const b = document.getElementById('alert-banner');
      const t = document.getElementById('alert-banner-text');
      b.className = `flex items-center justify-between px-4 py-2 text-xs font-medium border-b z-30 ${
        isError ? 'bg-red-950/90 text-red-200 border-red-800' : 'bg-amber-950/90 text-amber-200 border-amber-800'
      }`;
      t.textContent = msg;
    }

    document.getElementById('alert-banner-close').onclick = () => {
      document.getElementById('alert-banner').classList.add('hidden');
    };

    /*************************************************************************
     * 5. DETERMINISTIC COMPOSITOR PIPELINE (Section 5.4 & Journey 8)
     *************************************************************************/
    const compositeCanvas = document.getElementById('composite-canvas');
    const compositeCtx = compositeCanvas.getContext('2d', { willReadFrequently: true });
    const overlayCanvas = document.getElementById('overlay-canvas');
    const overlayCtx = overlayCanvas.getContext('2d');
    const histogramSampleCanvas = createOffscreenCanvas(128, 128);

    function compositeDocumentToCanvas(targetCanvas) {
      const { width, height, background, layers } = state.doc;
      if (targetCanvas.width !== width || targetCanvas.height !== height) {
        targetCanvas.width = width;
        targetCanvas.height = height;
      }
      const ctx = targetCanvas.getContext('2d');
      ctx.save();
      ctx.clearRect(0, 0, width, height);

      // 1. Background
      if (background !== 'transparent') {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }

      // 2. Bottom-to-Top Layers
      for (const layer of layers) {
        if (!layer.visible || layer.opacity <= 0) continue;

        if (layer.kind === 'adjustment') {
          applyAdjustmentLayerToContext(ctx, layer, width, height);
          continue;
        }

        // Render individual layer onto an isolated offscreen surface so masks apply cleanly
        const layerSurf = createOffscreenCanvas(width, height);
        const lctx = layerSurf.getContext('2d');

        lctx.save();
        const { x, y, scale, rotation } = layer.transform;

        if (layer.kind === 'raster' || layer.kind === 'image') {
          const asset = AssetStore.get(layer.assetId);
          if (asset) {
            const cx = x + (asset.width * scale) / 2;
            const cy = y + (asset.height * scale) / 2;
            lctx.translate(cx, cy);
            lctx.rotate((rotation * Math.PI) / 180);
            lctx.scale(scale, scale);
            lctx.drawImage(asset, -asset.width / 2, -asset.height / 2);
          }
        } else if (layer.kind === 'text') {
          lctx.translate(x, y);
          lctx.rotate((rotation * Math.PI) / 180);
          lctx.scale(scale, scale);
          lctx.font = `${layer.fontWeight || 700} ${layer.fontSize || 52}px Inter, sans-serif`;
          lctx.fillStyle = layer.color || '#111827';
          lctx.textBaseline = 'top';
          const lines = (layer.text || '').split('\n');
          lines.forEach((line, i) => lctx.fillText(line, 0, i * (layer.fontSize || 52) * 1.2));
        } else if (layer.kind === 'shape') {
          const w = layer.width || 240;
          const h = layer.height || 160;
          const cx = x + (w * scale) / 2;
          const cy = y + (h * scale) / 2;
          lctx.translate(cx, cy);
          lctx.rotate((rotation * Math.PI) / 180);
          lctx.scale(scale, scale);
          lctx.fillStyle = layer.fillColor || '#0ea5e9';
          lctx.strokeStyle = layer.strokeColor || '#ffffff';
          lctx.lineWidth = layer.strokeWidth || 3;
          lctx.beginPath();
          lctx.roundRect(-w / 2, -h / 2, w, h, layer.cornerRadius || 12);
          lctx.fill();
          if (layer.strokeWidth > 0) lctx.stroke();
        }
        lctx.restore();

        // Apply Layer Mask if present and enabled (Journey 5 & 6)
        if (layer.maskAssetId && layer.maskEnabled !== false) {
          const maskCanvas = AssetStore.get(layer.maskAssetId);
          if (maskCanvas) {
            lctx.save();
            lctx.globalCompositeOperation = 'destination-in';
            lctx.drawImage(maskCanvas, 0, 0);
            lctx.restore();
          }
        }

        // Composite onto main canvas with blend mode & opacity
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
        ctx.globalCompositeOperation = layer.blendMode || 'source-over';
        ctx.drawImage(layerSurf, 0, 0);
        ctx.restore();
      }

      ctx.restore();
    }

    function applyAdjustmentLayerToContext(ctx, layer, width, height) {
      const imgData = ctx.getImageData(0, 0, width, height);
      const d = imgData.data;
      const type = layer.adjType;
      const val = Number(layer.adjValue ?? 0);
      const val2 = Number(layer.adjValue2 ?? 0);
      const alpha = layer.opacity;

      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];

        if (type === 'brightness') {
          // val = brightness (-100..100), val2 = contrast (-100..100)
          const factor = (259 * (val2 + 255)) / (255 * (259 - val2));
          r = factor * (r - 128) + 128 + val * 1.8;
          g = factor * (g - 128) + 128 + val * 1.8;
          b = factor * (b - 128) + 128 + val * 1.8;
        } else if (type === 'exposure') {
          const mult = Math.pow(2, val / 40);
          r *= mult; g *= mult; b *= mult;
        } else if (type === 'invert') {
          r = 255 - r; g = 255 - g; b = 255 - b;
        } else if (type === 'grayscale') {
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = g = b = lum;
        } else if (type === 'threshold') {
          const thresh = 128 + val;
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = g = b = lum >= thresh ? 255 : 0;
        } else if (type === 'hue') {
          // Fast saturation/tint shift
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const sat = 1 + val2 / 100;
          r = lum + (r - lum) * sat + val * 0.8;
          g = lum + (g - lum) * sat;
          b = lum + (b - lum) * sat - val * 0.8;
        }

        d[i]     = d[i]     * (1 - alpha) + Math.max(0, Math.min(255, r)) * alpha;
        d[i + 1] = d[i + 1] * (1 - alpha) + Math.max(0, Math.min(255, g)) * alpha;
        d[i + 2] = d[i + 2] * (1 - alpha) + Math.max(0, Math.min(255, b)) * alpha;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    /*************************************************************************
     * 6. REAL-TIME HISTOGRAM & OVERLAY RENDERING (Selection Marching Ants)
     *************************************************************************/
    let antsOffset = 0;
    setInterval(() => {
      if (state.hasSelection) {
        antsOffset = (antsOffset + 1) % 8;
        renderOverlay();
      }
    }, 180);

    function renderOverlay(previewShape = null) {
      const { width, height } = state.doc;
      if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
        overlayCanvas.width = width;
        overlayCanvas.height = height;
      }
      overlayCtx.clearRect(0, 0, width, height);

      // Draw active 8-bit selection boundary (Marching Ants)
      if (state.hasSelection && state.selectionMask) {
        overlayCtx.save();
        overlayCtx.strokeStyle = '#0ea5e9';
        overlayCtx.lineWidth = 1.5 / state.viewport.zoom;
        overlayCtx.setLineDash([4, 4]);
        overlayCtx.lineDashOffset = -antsOffset;
        overlayCtx.beginPath();
        const mask = state.selectionMask;
        const step = Math.max(1, Math.floor(2 / state.viewport.zoom));
        for (let y = 0; y < height; y += step) {
          for (let x = 0; x < width; x += step) {
            const idx = y * width + x;
            if (mask[idx] > 127) {
              const right = x + step < width ? mask[y * width + (x + step)] > 127 : false;
              const down = y + step < height ? mask[(y + step) * width + x] > 127 : false;
              if (!right) { overlayCtx.moveTo(x + step, y); overlayCtx.lineTo(x + step, y + step); }
              if (!down)  { overlayCtx.moveTo(x, y + step); overlayCtx.lineTo(x + step, y + step); }
            }
          }
        }
        overlayCtx.stroke();
        overlayCtx.restore();
      }

      // Active Dragging Marquee / Lasso Preview
      if (previewShape) {
        overlayCtx.save();
        overlayCtx.strokeStyle = '#38bdf8';
        overlayCtx.lineWidth = 1.5 / state.viewport.zoom;
        overlayCtx.setLineDash([5, 3]);
        if (previewShape.type === 'rect') {
          overlayCtx.strokeRect(previewShape.x, previewShape.y, previewShape.w, previewShape.h);
        } else if (previewShape.type === 'ellipse') {
          overlayCtx.beginPath();
          overlayCtx.ellipse(
            previewShape.x + previewShape.w / 2,
            previewShape.y + previewShape.h / 2,
            Math.abs(previewShape.w / 2),
            Math.abs(previewShape.h / 2),
            0, 0, Math.PI * 2
          );
          overlayCtx.stroke();
        } else if (previewShape.type === 'lasso' && previewShape.points.length > 1) {
          overlayCtx.beginPath();
          overlayCtx.moveTo(previewShape.points[0].x, previewShape.points[0].y);
          previewShape.points.forEach(p => overlayCtx.lineTo(p.x, p.y));
          overlayCtx.stroke();
        }
        overlayCtx.restore();
      }
    }

    function updateHistogram() {
      const hCanvas = document.getElementById('histogram-canvas');
      const hCtx = hCanvas.getContext('2d');
      hCtx.clearRect(0, 0, hCanvas.width, hCanvas.height);

      const sampleWidth = Math.min(128, compositeCanvas.width);
      const sampleHeight = Math.min(128, compositeCanvas.height);
      histogramSampleCanvas.width = sampleWidth;
      histogramSampleCanvas.height = sampleHeight;
      const sampleCtx = histogramSampleCanvas.getContext('2d', { willReadFrequently: true });
      sampleCtx.drawImage(compositeCanvas, 0, 0, sampleWidth, sampleHeight);
      const img = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
      const bins = new Uint32Array(32);
      let maxBin = 1;

      for (let i = 0; i < img.length; i += 4) {
        const lum = (img[i] + img[i + 1] + img[i + 2]) / 3;
        const b = Math.min(31, Math.floor((lum / 256) * 32));
        bins[b]++;
        if (bins[b] > maxBin) maxBin = bins[b];
      }

      hCtx.fillStyle = '#38bdf8';
      const barW = hCanvas.width / 32;
      for (let i = 0; i < 32; i++) {
        const h = (bins[i] / maxBin) * hCanvas.height;
        hCtx.fillRect(i * barW, hCanvas.height - h, barW - 0.5, h);
      }
    }

    /*************************************************************************
     * 7. LAYER CREATION & MANAGEMENT HELPERS
     *************************************************************************/
    function createAlphaMaskCanvas(width, height, fillWhite = true) {
      const c = createOffscreenCanvas(width, height);
      const ctx = c.getContext('2d');
      if (fillWhite) {
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.fillRect(0, 0, width, height);
      }
      return c;
    }

    function getSelectedLayer() {
      return state.doc.layers.find(l => l.id === state.selectedLayerId) || null;
    }

    function addPaintableRasterLayer(name = `Raster Layer ${state.doc.layers.length + 1}`, populateDemoArt = false) {
      const snap = History.captureSnapshot(`Add Layer "${name}"`);
      const assetId = `asset-raster-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const c = createOffscreenCanvas(state.doc.width, state.doc.height);

      if (populateDemoArt) {
        const ctx = c.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, state.doc.width, state.doc.height);
        grad.addColorStop(0, '#0f172a');
        grad.addColorStop(0.5, '#1e1b4b');
        grad.addColorStop(1, '#0369a1');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, state.doc.width, state.doc.height);

        // Decorative geometric circles for immediate testing
        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(state.doc.width * 0.32, state.doc.height * 0.48, 130, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.arc(state.doc.width * 0.65, state.doc.height * 0.52, 110, 0, Math.PI * 2);
        ctx.fill();
      }

      AssetStore.set(assetId, c);
      const layer = {
        id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        kind: 'raster',
        name,
        assetId,
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'source-over',
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        maskAssetId: null,
        maskEnabled: true
      };
      state.doc.layers.push(layer);
      state.selectedLayerId = layer.id;
      History.pushBeforeState(snap);
      renderAll();
    }

    function addVectorTextLayer(customText = 'AETHER STUDIO v2') {
      const snap = History.captureSnapshot('Add Vector Text Layer');
      const layer = {
        id: `layer-text-${Date.now()}`,
        kind: 'text',
        name: `Text: ${customText.slice(0, 14)}`,
        text: customText,
        fontSize: 64,
        fontWeight: 800,
        color: '#ffffff',
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'source-over',
        transform: { x: Math.round(state.doc.width * 0.22), y: Math.round(state.doc.height * 0.22), scale: 1, rotation: 0 },
        maskAssetId: null,
        maskEnabled: true
      };
      state.doc.layers.push(layer);
      state.selectedLayerId = layer.id;
      History.pushBeforeState(snap);
      renderAll();
    }

    function addVectorShapeLayer() {
      const snap = History.captureSnapshot('Add Vector Shape Layer');
      const layer = {
        id: `layer-shape-${Date.now()}`,
        kind: 'shape',
        name: `Shape ${state.doc.layers.length + 1}`,
        width: 280,
        height: 170,
        fillColor: '#0ea5e9',
        strokeColor: '#ffffff',
        strokeWidth: 3,
        cornerRadius: 16,
        visible: true,
        locked: false,
        opacity: 0.9,
        blendMode: 'source-over',
        transform: { x: Math.round(state.doc.width * 0.38), y: Math.round(state.doc.height * 0.42), scale: 1, rotation: 0 },
        maskAssetId: null,
        maskEnabled: true
      };
      state.doc.layers.push(layer);
      state.selectedLayerId = layer.id;
      History.pushBeforeState(snap);
      renderAll();
    }

    function addAdjustmentLayer(adjType) {
      const snap = History.captureSnapshot(`Add ${adjType.toUpperCase()} Adjustment Layer`);
      const layer = {
        id: `layer-adj-${Date.now()}`,
        kind: 'adjustment',
        name: `Adj: ${adjType.toUpperCase()}`,
        adjType,
        adjValue: adjType === 'brightness' ? 20 : adjType === 'exposure' ? 15 : 0,
        adjValue2: adjType === 'brightness' ? 15 : adjType === 'hue' ? 25 : 0,
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'source-over',
        transform: { x: 0, y: 0, scale: 1, rotation: 0 }
      };
      state.doc.layers.push(layer);
      state.selectedLayerId = layer.id;
      History.pushBeforeState(snap);
      renderAll();
    }

    function attachOrConvertSelectionToLayerMask() {
      const layer = getSelectedLayer();
      if (!layer || layer.kind === 'adjustment') {
        showBanner('Select a Raster, Image, Text, or Shape layer to attach a Layer Mask.', false);
        return;
      }
      const snap = History.captureSnapshot(`Create Layer Mask on "${layer.name}"`);
      const { width, height } = state.doc;
      const maskCanvas = createOffscreenCanvas(width, height);
      const mctx = maskCanvas.getContext('2d');
      const imgData = mctx.createImageData(width, height);
      const d = imgData.data;

      for (let i = 0; i < width * height; i++) {
        const alpha = state.hasSelection && state.selectionMask ? state.selectionMask[i] : 255;
        d[i * 4] = 255;
        d[i * 4 + 1] = 255;
        d[i * 4 + 2] = 255;
        d[i * 4 + 3] = alpha;
      }
      mctx.putImageData(imgData, 0, 0);

      const maskId = `mask-${Date.now()}`;
      AssetStore.set(maskId, maskCanvas);
      layer.maskAssetId = maskId;
      layer.maskEnabled = true;

      // Clear active selection outline so the new mask is immediately visible
      state.hasSelection = false;
      state.selectionMask = null;

      History.pushBeforeState(snap);
      renderAll();
    }

    /*************************************************************************
     * 8. RASTER FILTERS (Gaussian Blur, Sharpen, Film Grain, Pixelate)
     *************************************************************************/
    function applyRasterFilterToSelectedLayer(filterType) {
      const layer = getSelectedLayer();
      if (!layer || (layer.kind !== 'raster' && layer.kind !== 'image')) {
        showBanner('Select an Image or Raster layer to apply a pixel filter.', false);
        return;
      }
      const surf = AssetStore.get(layer.assetId);
      if (!surf) return;

      const snap = History.captureSnapshot(`Apply ${filterType.toUpperCase()} Filter`);
      const w = surf.width, h = surf.height;
      const ctx = surf.getContext('2d');

      if (filterType === 'blur') {
        const temp = cloneCanvas(surf);
        ctx.clearRect(0, 0, w, h);
        ctx.filter = 'blur(5px)';
        ctx.drawImage(temp, 0, 0);
        ctx.filter = 'none';
      } else if (filterType === 'pixelate') {
        const block = 8;
        const small = createOffscreenCanvas(Math.max(1, Math.floor(w / block)), Math.max(1, Math.floor(h / block)));
        const sctx = small.getContext('2d');
        sctx.imageSmoothingEnabled = false;
        sctx.drawImage(surf, 0, 0, small.width, small.height);
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
      } else if (filterType === 'noise') {
        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          const n = (Math.random() - 0.5) * 42;
          d[i] = Math.max(0, Math.min(255, d[i] + n));
          d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
          d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
        }
        ctx.putImageData(imgData, 0, 0);
      } else if (filterType === 'sharpen') {
        const src = ctx.getImageData(0, 0, w, h);
        const out = ctx.createImageData(w, h);
        const sd = src.data, od = out.data;
        const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const idx = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
              let sum = 0;
              for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                  const pIdx = ((y + ky) * w + (x + kx)) * 4 + c;
                  sum += sd[pIdx] * kernel[(ky + 1) * 3 + (kx + 1)];
                }
              }
              od[idx + c] = Math.max(0, Math.min(255, sum));
            }
            od[idx + 3] = sd[idx + 3];
          }
        }
        ctx.putImageData(out, 0, 0);
      }

      History.pushBeforeState(snap);
      renderAll();
    }

    /*************************************************************************
     * 9. POINTER INTERACTION (Move, Paint, Erase, Marquee, Lasso, Magic Wand)
     *************************************************************************/
    const pasteboard = document.getElementById('pasteboard');
    let pointerState = {
      active: false,
      mode: null,
      startX: 0,
      startY: 0,
      lastDocX: 0,
      lastDocY: 0,
      initialPanX: 0,
      initialPanY: 0,
      initialTransform: null,
      preStrokeSnapshot: null,
      lassoPoints: []
    };

    function clientToDocument(clientX, clientY) {
      const rect = pasteboard.getBoundingClientRect();
      const vx = clientX - rect.left;
      const vy = clientY - rect.top;
      return {
        x: Math.round((vx - state.viewport.panX) / state.viewport.zoom),
        y: Math.round((vy - state.viewport.panY) / state.viewport.zoom)
      };
    }

    function paintDab(docX, docY) {
      let layer = getSelectedLayer();
      if (!layer) return;

      // Target either the layer's mask or its pixel surface
      let targetSurf = null;
      const paintingMask = state.brush.paintMask && layer.maskAssetId;

      if (paintingMask) {
        targetSurf = AssetStore.get(layer.maskAssetId);
      } else {
        if (layer.kind !== 'raster' && layer.kind !== 'image') return;
        targetSurf = AssetStore.get(layer.assetId);
      }
      if (!targetSurf) return;

      // Convert document coordinates to layer-local pixel coordinates
      const localX = paintingMask ? docX : (docX - layer.transform.x) / layer.transform.scale;
      const localY = paintingMask ? docY : (docY - layer.transform.y) / layer.transform.scale;

      const ctx = targetSurf.getContext('2d');
      const radius = state.brush.size / 2;

      ctx.save();

      // If an active 8-bit selection exists, clip the brush dab to the selection
      if (state.hasSelection && state.selectionMask) {
        // Check bounds center
        const ix = Math.floor(docX), iy = Math.floor(docY);
        if (ix < 0 || iy < 0 || ix >= state.doc.width || iy >= state.doc.height) {
          ctx.restore();
          return;
        }
        if (state.selectionMask[iy * state.doc.width + ix] < 128) {
          ctx.restore();
          return;
        }
      }

      ctx.globalAlpha = state.brush.opacity;
      if (state.activeTool === 'eraser' || (paintingMask && state.brush.color === '#000000')) {
        ctx.globalCompositeOperation = 'destination-out';
      } else {
        ctx.globalCompositeOperation = 'source-over';
      }

      const grad = ctx.createRadialGradient(localX, localY, radius * state.brush.hardness * 0.8, localX, localY, radius);
      const col = paintingMask ? '#ffffff' : state.brush.color;
      grad.addColorStop(0, col);
      grad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(localX, localY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function runMagicWandFloodFill(startX, startY) {
      const { width, height } = state.doc;
      if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;

      const snap = History.captureSnapshot('Magic Wand Selection');
      const imgData = compositeCtx.getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(width * height);
      const visited = new Uint8Array(width * height);

      const startIdx = (startY * width + startX) * 4;
      const r0 = imgData[startIdx], g0 = imgData[startIdx + 1], b0 = imgData[startIdx + 2];
      const tol = state.wandTolerance;

      const stack = [startY * width + startX];
      visited[startY * width + startX] = 1;

      while (stack.length > 0) {
        const pos = stack.pop();
        mask[pos] = 255;
        const x = pos % width;
        const y = (pos - x) / width;

        const neighbors = [];
        if (x > 0) neighbors.push(pos - 1);
        if (x < width - 1) neighbors.push(pos + 1);
        if (y > 0) neighbors.push(pos - width);
        if (y < height - 1) neighbors.push(pos + width);

        for (const nPos of neighbors) {
          if (visited[nPos]) continue;
          visited[nPos] = 1;
          const p = nPos * 4;
          const diff = (Math.abs(imgData[p] - r0) + Math.abs(imgData[p + 1] - g0) + Math.abs(imgData[p + 2] - b0)) / 3;
          if (diff <= tol) {
            stack.push(nPos);
          }
        }
      }

      state.selectionMask = mask;
      state.hasSelection = true;
      History.pushBeforeState(snap);
      renderAll();
    }

    pasteboard.addEventListener('pointerdown', (e) => {
      const docPt = clientToDocument(e.clientX, e.clientY);
      pointerState.active = true;
      pointerState.startX = e.clientX;
      pointerState.startY = e.clientY;
      pointerState.lastDocX = docPt.x;
      pointerState.lastDocY = docPt.y;

      if (state.activeTool === 'hand' || e.button === 1) {
        pointerState.mode = 'pan';
        pointerState.initialPanX = state.viewport.panX;
        pointerState.initialPanY = state.viewport.panY;
        return;
      }

      if (state.activeTool === 'zoom') {
        const factor = e.altKey ? 0.8 : 1.25;
        state.viewport.zoom = Math.max(0.1, Math.min(8, Number((state.viewport.zoom * factor).toFixed(2))));
        pointerState.active = false;
        renderAll();
        return;
      }

      if (state.activeTool === 'text') {
        addVectorTextLayer('Editable Text');
        setActiveTool('move');
        pointerState.active = false;
        return;
      }

      if (state.activeTool === 'shape') {
        addVectorShapeLayer();
        setActiveTool('move');
        pointerState.active = false;
        return;
      }

      if (state.activeTool === 'wand') {
        runMagicWandFloodFill(docPt.x, docPt.y);
        pointerState.active = false;
        return;
      }

      if (state.activeTool === 'marquee-rect' || state.activeTool === 'marquee-ellipse') {
        pointerState.mode = state.activeTool;
        return;
      }

      if (state.activeTool === 'lasso') {
        pointerState.mode = 'lasso';
        pointerState.lassoPoints = [{ x: docPt.x, y: docPt.y }];
        return;
      }

      if (state.activeTool === 'brush' || state.activeTool === 'eraser') {
        const layer = getSelectedLayer();
        if (!layer || layer.locked) {
          showBanner('Select an unlocked Raster or Image layer to paint.', false);
          pointerState.active = false;
          return;
        }
        pointerState.mode = 'paint';
        pointerState.preStrokeSnapshot = History.captureSnapshot(
          state.activeTool === 'brush' ? 'Brush Stroke' : 'Eraser Stroke'
        );
        paintDab(docPt.x, docPt.y);
        compositeDocumentToCanvas(compositeCanvas);
        return;
      }

      if (state.activeTool === 'move') {
        const layer = getSelectedLayer();
        if (!layer || layer.locked || layer.kind === 'adjustment') {
          pointerState.active = false;
          return;
        }
        pointerState.mode = 'move-layer';
        pointerState.preStrokeSnapshot = History.captureSnapshot(`Move "${layer.name}"`);
        pointerState.initialTransform = { ...layer.transform };
      }
    });

    window.addEventListener('pointermove', (e) => {
      const docPt = clientToDocument(e.clientX, e.clientY);
      document.getElementById('cursor-coords-readout').textContent = `X: ${docPt.x}, Y:${docPt.y}`;

      if (!pointerState.active) return;

      if (pointerState.mode === 'pan') {
        state.viewport.panX = pointerState.initialPanX + (e.clientX - pointerState.startX);
        state.viewport.panY = pointerState.initialPanY + (e.clientY - pointerState.startY);
        updateStageTransform();
        return;
      }

      if (pointerState.mode === 'move-layer') {
        const layer = getSelectedLayer();
        if (!layer) return;
        const dx = Math.round((e.clientX - pointerState.startX) / state.viewport.zoom);
        const dy = Math.round((e.clientY - pointerState.startY) / state.viewport.zoom);
        layer.transform.x = pointerState.initialTransform.x + dx;
        layer.transform.y = pointerState.initialTransform.y + dy;
        compositeDocumentToCanvas(compositeCanvas);
        syncTransformInputs();
        return;
      }

      if (pointerState.mode === 'paint') {
        const dist = Math.hypot(docPt.x - pointerState.lastDocX, docPt.y - pointerState.lastDocY);
        const steps = Math.max(1, Math.ceil(dist / Math.max(2, state.brush.size * 0.2)));
        for (let i = 1; i <= steps; i++) {
          const ix = pointerState.lastDocX + ((docPt.x - pointerState.lastDocX) * i) / steps;
          const iy = pointerState.lastDocY + ((docPt.y - pointerState.lastDocY) * i) / steps;
          paintDab(ix, iy);
        }
        pointerState.lastDocX = docPt.x;
        pointerState.lastDocY = docPt.y;
        compositeDocumentToCanvas(compositeCanvas);
        return;
      }

      if (pointerState.mode === 'marquee-rect' || pointerState.mode === 'marquee-ellipse') {
        const startDoc = clientToDocument(pointerState.startX, pointerState.startY);
        renderOverlay({
          type: pointerState.mode === 'marquee-rect' ? 'rect' : 'ellipse',
          x: Math.min(startDoc.x, docPt.x),
          y: Math.min(startDoc.y, docPt.y),
          w: Math.abs(docPt.x - startDoc.x),
          h: Math.abs(docPt.y - startDoc.y)
        });
        return;
      }

      if (pointerState.mode === 'lasso') {
        pointerState.lassoPoints.push({ x: docPt.x, y: docPt.y });
        renderOverlay({ type: 'lasso', points: pointerState.lassoPoints });
      }
    });

    window.addEventListener('pointerup', (e) => {
      if (!pointerState.active) return;
      const docPt = clientToDocument(e.clientX, e.clientY);

      if ((pointerState.mode === 'move-layer' || pointerState.mode === 'paint') && pointerState.preStrokeSnapshot) {
        History.pushBeforeState(pointerState.preStrokeSnapshot);
        renderAll();
      } else if (pointerState.mode === 'marquee-rect' || pointerState.mode === 'marquee-ellipse') {
        const startDoc = clientToDocument(pointerState.startX, pointerState.startY);
        const x0 = Math.max(0, Math.min(startDoc.x, docPt.x));
        const y0 = Math.max(0, Math.min(startDoc.y, docPt.y));
        const x1 = Math.min(state.doc.width, Math.max(startDoc.x, docPt.x));
        const y1 = Math.min(state.doc.height, Math.max(startDoc.y, docPt.y));

        if (x1 - x0 > 3 && y1 - y0 > 3) {
          const snap = History.captureSnapshot('Marquee Selection');
          const mask = new Uint8Array(state.doc.width * state.doc.height);
          const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
          const cx = x0 + rx, cy = y0 + ry;

          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              if (pointerState.mode === 'marquee-rect') {
                mask[y * state.doc.width + x] = 255;
              } else {
                const norm = Math.pow((x - cx) / rx, 2) + Math.pow((y - cy) / ry, 2);
                if (norm <= 1) mask[y * state.doc.width + x] = 255;
              }
            }
          }
          state.selectionMask = mask;
          state.hasSelection = true;
          History.pushBeforeState(snap);
        }
        renderAll();
      } else if (pointerState.mode === 'lasso' && pointerState.lassoPoints.length > 2) {
        const snap = History.captureSnapshot('Lasso Selection');
        const temp = createOffscreenCanvas(state.doc.width, state.doc.height);
        const tctx = temp.getContext('2d');
        tctx.fillStyle = '#ffffff';
        tctx.beginPath();
        tctx.moveTo(pointerState.lassoPoints[0].x, pointerState.lassoPoints[0].y);
        pointerState.lassoPoints.forEach(p => tctx.lineTo(p.x, p.y));
        tctx.closePath();
        tctx.fill();

        const data = tctx.getImageData(0, 0, state.doc.width, state.doc.height).data;
        const mask = new Uint8Array(state.doc.width * state.doc.height);
        for (let i = 0; i < mask.length; i++) {
          mask[i] = data[i * 4 + 3] > 127 ? 255 : 0;
        }
        state.selectionMask = mask;
        state.hasSelection = true;
        History.pushBeforeState(snap);
        renderAll();
      }

      pointerState.active = false;
      pointerState.mode = null;
      pointerState.preStrokeSnapshot = null;
    });

    // Wheel Zoom inside Pasteboard
    pasteboard.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.1 : 0.9;
      state.viewport.zoom = Math.max(0.1, Math.min(8, Number((state.viewport.zoom * delta).toFixed(2))));
      updateStageTransform();
    }, { passive: false });

    /*************************************************************************
     * 10. INDEXEDDB AUTOSAVE & LOSSLESS .AETHER PROJECT I/O (Journey 7)
     *************************************************************************/
    const DB_NAME = 'AetherStudioV2DB';
    const STORE_NAME = 'autosave';

    function openIDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function serializeProjectPayload() {
      const assetsObj = {};
      for (const [id, canvas] of AssetStore.entries()) {
        assetsObj[id] = {
          width: canvas.width,
          height: canvas.height,
          dataUrl: canvas.toDataURL('image/png')
        };
      }
      return {
        magic: 'AETHER_PROJECT_V2',
        savedAt: new Date().toISOString(),
        doc: state.doc,
        assets: assetsObj
      };
    }

    function validateProjectPayload(payload) {
      const doc = payload?.doc;
      if (payload?.magic !== 'AETHER_PROJECT_V2' || !doc ||
          !Number.isInteger(doc.width) || !Number.isInteger(doc.height) ||
          doc.width < 1 || doc.height < 1 || doc.width > 16384 || doc.height > 16384 ||
          doc.width * doc.height > 64_000_000 || typeof doc.name !== 'string' ||
          !Array.isArray(doc.layers) || doc.layers.length > 500) {
        throw new Error('Rejected: Invalid project header or document dimensions.');
      }
      if (!payload.assets || typeof payload.assets !== 'object' || Array.isArray(payload.assets)) {
        throw new Error('Rejected: Project assets are missing or invalid.');
      }

      const entries = Object.entries(payload.assets);
      if (entries.length > 500) throw new Error('Rejected: Project contains too many assets.');
      const assetIds = new Set(entries.map(([id]) => id));
      const layerIds = new Set();
      for (const layer of doc.layers) {
        if (!layer || typeof layer.id !== 'string' || layerIds.has(layer.id) ||
            !['raster', 'image', 'text', 'shape', 'adjustment'].includes(layer.kind) ||
            typeof layer.name !== 'string' || !layer.transform ||
            !['x', 'y', 'scale', 'rotation'].every((key) => Number.isFinite(layer.transform[key])) ||
            layer.transform.scale <= 0 || layer.transform.scale > 20) {
          throw new Error('Rejected: Project contains an invalid layer.');
        }
        layerIds.add(layer.id);
        if (['raster', 'image'].includes(layer.kind) && !assetIds.has(layer.assetId)) {
          throw new Error('Rejected: A layer references a missing image asset.');
        }
        if (layer.maskAssetId && !assetIds.has(layer.maskAssetId)) {
          throw new Error('Rejected: A layer references a missing mask asset.');
        }
        if (layer.kind === 'adjustment' &&
            !['brightness', 'hue', 'exposure', 'invert', 'grayscale', 'threshold'].includes(layer.adjType)) {
          throw new Error('Rejected: Project contains an unsupported adjustment layer.');
        }
      }

      let totalPixels = 0;
      for (const [, asset] of entries) {
        if (!asset || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) ||
            asset.width < 1 || asset.height < 1 || asset.width > 16384 || asset.height > 16384 ||
            typeof asset.dataUrl !== 'string' || !asset.dataUrl.startsWith('data:image/png;base64,')) {
          throw new Error('Rejected: Project contains an invalid image asset.');
        }
        totalPixels += asset.width * asset.height;
        if (totalPixels > 128_000_000) throw new Error('Rejected: Project image assets exceed the memory budget.');
      }
      return entries;
    }

    async function hydrateProjectPayload(payload) {
      const entries = validateProjectPayload(payload);
      const hydratedAssets = new Map();
      for (const [id, item] of entries) {
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('Rejected: An image asset could not be decoded.'));
          img.src = item.dataUrl;
        });
        if (img.naturalWidth !== item.width || img.naturalHeight !== item.height) {
          throw new Error('Rejected: Image asset dimensions do not match the project metadata.');
        }
        const c = createOffscreenCanvas(item.width, item.height);
        c.getContext('2d').drawImage(img, 0, 0);
        hydratedAssets.set(id, c);
      }
      AssetStore.clear();
      for (const [id, canvas] of hydratedAssets) AssetStore.set(id, canvas);
      state.doc = payload.doc;
      state.selectedLayerId = state.doc.layers.length
        ? state.doc.layers[state.doc.layers.length - 1].id
        : null;
      state.hasSelection = false;
      state.selectionMask = null;
      History.undoStack = [];
      History.redoStack = [];
      fitDocument();
      renderAll();
    }

    async function triggerIndexedDBAutosave() {
      try {
        const payload = serializeProjectPayload();
        const indicator = document.getElementById('autosave-indicator');
        indicator.querySelector('span:last-child').textContent = 'Saving…';
        const db = await openIDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(payload, 'latest');
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error('Autosave transaction failed.'));
          tx.onabort = () => reject(tx.error || new Error('Autosave transaction was aborted.'));
        });
        db.close();
        indicator.querySelector('span:last-child').textContent = `Autosaved ${new Date().toLocaleTimeString()}`;
        indicator.title = 'Project is saved in this browser.';
      } catch (error) {
        const indicator = document.getElementById('autosave-indicator');
        indicator.querySelector('span:last-child').textContent = 'Autosave unavailable';
        indicator.title = error.message || 'This browser could not store the autosave.';
      }
    }

    document.getElementById('btn-recover-autosave').onclick = async () => {
      try {
        const db = await openIDB();
        const result = await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get('latest');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error('Autosave could not be read.'));
        });
        db.close();
        if (!result) {
          showBanner('No previous IndexedDB autosave session found.', false);
          return;
        }
        await hydrateProjectPayload(result);
        showBanner(`Recovered project "${state.doc.name}" from IndexedDB autosave.`, false);
      } catch (err) {
        showBanner('Autosave recovery failed: ' + err.message, true);
      }
    };

    document.getElementById('btn-save-proj').onclick = () => {
      try {
        const payload = serializeProjectPayload();
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.doc.name.replace(/\s+/g, '_')}.aether`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        showBanner(`Could not save project: ${error.message}`, true);
      }
    };

    document.getElementById('btn-open-proj').onclick = () => {
      document.getElementById('project-open-input').click();
    };

    document.getElementById('project-open-input').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        if (file.size > 256 * 1024 * 1024) throw new Error('Project file exceeds the 256 MB safety limit.');
        const text = await file.text();
        const parsed = JSON.parse(text);
        await hydrateProjectPayload(parsed);
      } catch (err) {
        showBanner('Corrupt .aether project file: ' + err.message, true);
      }
    };

    /*************************************************************************
     * 11. IMAGE IMPORT & EXPORT HANDLERS (Journeys 1, 8, 9)
     *************************************************************************/
    document.getElementById('btn-import-img').onclick = () => {
      document.getElementById('file-import-input').click();
    };

    document.getElementById('file-import-input').onchange = async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const sig = validateFileSignature(bytes);
        if (!sig.valid) {
          showBanner(sig.error, true);
          return;
        }
        const blob = new Blob([bytes], { type: sig.mime });
        const bitmap = await createImageBitmap(blob);
        const mp = bitmap.width * bitmap.height;
        if (mp > 64_000_000) {
          bitmap.close();
          showBanner(`Rejected: Image is ${(mp / 1e6).toFixed(1)} MP, exceeding the 64 MP memory budget.`, true);
          return;
        }
        if (mp >= 25_000_000) {
          showBanner(`Warning: Large image (${(mp / 1e6).toFixed(1)} MP >= 25 MP).`, false);
        }

        const snap = History.captureSnapshot(`Import "${file.name}"`);
        const assetId = `asset-img-${Date.now()}`;
        const c = createOffscreenCanvas(bitmap.width, bitmap.height);
        c.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();

        AssetStore.set(assetId, c);
        const layer = {
          id: `layer-img-${Date.now()}`,
          kind: 'image',
          name: file.name.replace(/\.[^/.]+$/, ''),
          assetId,
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'source-over',
          transform: {
            x: Math.round((state.doc.width - c.width) / 2),
            y: Math.round((state.doc.height - c.height) / 2),
            scale: 1,
            rotation: 0
          },
          maskAssetId: null,
          maskEnabled: true
        };
        state.doc.layers.push(layer);
        state.selectedLayerId = layer.id;
        History.pushBeforeState(snap);
        renderAll();
      } catch (error) {
        showBanner(`Image import failed for "${file.name}": ${error.message}`, true);
      }
    };

    function exportCompositeImage(mime, ext) {
      const exportCanvas = createOffscreenCanvas(state.doc.width, state.doc.height);
      compositeDocumentToCanvas(exportCanvas);
      exportCanvas.toBlob((blob) => {
        if (!blob) {
          showBanner('Image export failed: the browser could not encode this document.', true);
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.doc.name.replace(/\s+/g, '_')}.${ext}`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, mime, 0.92);
    }

    document.getElementById('btn-export-png').onclick = () => exportCompositeImage('image/png', 'png');
    document.getElementById('btn-export-jpg').onclick = () => exportCompositeImage('image/jpeg', 'jpg');

    /*************************************************************************
     * 12. UI SYNCHRONIZATION & BINDINGS
     *************************************************************************/
    const layerList = document.getElementById('layers-list');
    const rightDock = document.getElementById('right-dock');
    const stage = document.getElementById('canvas-stage');
    let previousPasteboardSize = { width: 0, height: 0 };

    function updateStageTransform() {
      stage.style.width = `${state.doc.width}px`;
      stage.style.height = `${state.doc.height}px`;
      stage.style.transform = `translate(${state.viewport.panX}px, ${state.viewport.panY}px) scale(${state.viewport.zoom})`;
      compositeCanvas.style.width = `${state.doc.width}px`;
      compositeCanvas.style.height = `${state.doc.height}px`;
      overlayCanvas.style.width = `${state.doc.width}px`;
      overlayCanvas.style.height = `${state.doc.height}px`;
      document.getElementById('zoom-readout').textContent = `${Math.round(state.viewport.zoom * 100)}%`;
      document.getElementById('doc-dimensions-readout').textContent =
        `${state.doc.width} × ${state.doc.height} px (sRGB)`;
    }

    function fitDocument() {
      const availableWidth = Math.max(1, pasteboard.clientWidth - 64);
      const availableHeight = Math.max(1, pasteboard.clientHeight - 64);
      state.viewport.zoom = Math.min(1, availableWidth / state.doc.width, availableHeight / state.doc.height);
      state.viewport.zoom = Math.max(0.1, Math.min(8, state.viewport.zoom));
      state.viewport.panX = Math.round((pasteboard.clientWidth - state.doc.width * state.viewport.zoom) / 2);
      state.viewport.panY = Math.max(28, Math.round((pasteboard.clientHeight - state.doc.height * state.viewport.zoom) / 2));
      previousPasteboardSize = { width: pasteboard.clientWidth, height: pasteboard.clientHeight };
      updateStageTransform();
    }

    function handleViewportResize() {
      const width = pasteboard.clientWidth;
      const height = pasteboard.clientHeight;
      state.viewport.panX += (width - previousPasteboardSize.width) / 2;
      state.viewport.panY += (height - previousPasteboardSize.height) / 2;
      previousPasteboardSize = { width, height };
      updateStageTransform();
    }

    function updateHistoryUI() {
      const historyList = document.getElementById('tab-history');
      historyList.replaceChildren();
      const entries = History.undoStack.slice().reverse();
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'px-2 py-3 text-zinc-500';
        empty.textContent = 'Your edits will appear here.';
        historyList.append(empty);
      } else {
        for (const entry of entries) {
          const item = document.createElement('div');
          item.className = 'rounded px-2 py-1.5 text-zinc-300 hover:bg-[#232834]';
          item.textContent = entry.label;
          historyList.append(item);
        }
      }
      document.getElementById('btn-undo').disabled = History.undoStack.length === 0;
      document.getElementById('btn-redo').disabled = History.redoStack.length === 0;
    }

    function renderLayerList() {
      layerList.replaceChildren();
      if (!state.doc.layers.length) {
        const empty = document.createElement('div');
        empty.className = 'rounded-lg border border-dashed border-[#343b49] px-3 py-6 text-center text-zinc-500';
        empty.textContent = 'No layers yet. Add paint, text, or a shape to get started.';
        layerList.append(empty);
        return;
      }

      [...state.doc.layers].reverse().forEach((layer) => {
        const row = document.createElement('div');
        row.className = `layer-row flex items-center gap-2 rounded-md border px-2 py-2 ${
          layer.id === state.selectedLayerId
            ? 'border-sky-500/60 bg-sky-950/35 text-white'
            : 'border-transparent bg-[#1b1f28] text-zinc-300 hover:bg-[#232834]'
        }`;
        row.title = `${layer.name} (${layer.kind})`;
        const selectLayer = () => {
          state.selectedLayerId = layer.id;
          renderAll();
        };

        const visibility = document.createElement('button');
        visibility.type = 'button';
        visibility.className = 'w-6 shrink-0 rounded px-1 text-center text-zinc-400 hover:bg-[#343b49] hover:text-white';
        visibility.textContent = layer.visible ? '●' : '○';
        visibility.title = layer.visible ? 'Hide layer' : 'Show layer';
        visibility.setAttribute('aria-label', visibility.title);
        visibility.addEventListener('click', (event) => {
          event.stopPropagation();
          const snapshot = History.captureSnapshot(`${layer.visible ? 'Hide' : 'Show'} "${layer.name}"`);
          layer.visible = !layer.visible;
          History.pushBeforeState(snapshot);
          renderAll();
        });

        const details = document.createElement('span');
        details.className = 'min-w-0 flex-1 truncate text-left';
        details.textContent = layer.name;
        const kind = document.createElement('span');
        kind.className = 'shrink-0 rounded bg-[#111318] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-zinc-500';
        kind.textContent = layer.kind;
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'flex min-w-0 flex-1 items-center justify-between gap-2 text-left';
        select.setAttribute('aria-pressed', String(layer.id === state.selectedLayerId));
        select.setAttribute('aria-label', `Select layer ${layer.name}`);
        select.addEventListener('click', selectLayer);
        select.append(details, kind);
        row.append(visibility, select);
        layerList.append(row);
      });
    }

    function appendInspectorField(parent, labelText, value, type, onChange, options = {}) {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 text-[11px] text-zinc-400';
      const caption = document.createElement('span');
      caption.className = 'w-16 shrink-0';
      caption.textContent = labelText;
      const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') input.type = type;
      input.className = 'min-w-0 flex-1 rounded border border-[#2e3440] bg-[#0f1115] px-2 py-1 text-zinc-100 focus:border-sky-500 focus:outline-none';
      if (type === 'textarea') input.rows = 3;
      if (type === 'color') input.className += ' h-8';
      if (type === 'number') {
        input.min = String(options.min ?? -100000);
        input.max = String(options.max ?? 100000);
        input.step = String(options.step ?? 1);
      }
      input.value = value ?? '';
      input.addEventListener('change', () => onChange(input.value));
      label.append(caption, input);
      parent.append(label);
      return input;
    }

    function renderInspector() {
      const layer = getSelectedLayer();
      const subInspector = document.getElementById('sub-inspector');
      const nameInput = document.getElementById('inp-layer-name');
      const blendInput = document.getElementById('inp-layer-blend');
      const opacityInput = document.getElementById('inp-layer-opacity');
      const transformInputs = ['num-x', 'num-y', 'num-scale', 'num-rot']
        .map((id) => document.getElementById(id));
      const inspectorInputs = [nameInput, blendInput, opacityInput, ...transformInputs];
      inspectorInputs.forEach((input) => { input.disabled = !layer; });
      if (!layer) {
        nameInput.value = '';
        opacityInput.value = '100';
        transformInputs.forEach((input, index) => { input.value = index === 2 ? '100' : '0'; });
        subInspector.replaceChildren();
        return;
      }

      nameInput.value = layer.name;
      blendInput.value = layer.blendMode || 'source-over';
      opacityInput.value = String(Math.round((layer.opacity ?? 1) * 100));
      transformInputs[0].value = String(Math.round(layer.transform.x));
      transformInputs[1].value = String(Math.round(layer.transform.y));
      transformInputs[2].value = String(Math.round(layer.transform.scale * 100));
      transformInputs[3].value = String(Math.round(layer.transform.rotation));
      document.getElementById('lbl-layer-opacity').textContent = `Opacity ${opacityInput.value}%`;
      subInspector.replaceChildren();

      const snapshotChange = (label, mutate) => {
        const snapshot = History.captureSnapshot(label);
        mutate();
        History.pushBeforeState(snapshot);
        renderAll();
      };
      if (layer.kind === 'text') {
        appendInspectorField(subInspector, 'Text', layer.text, 'textarea', (value) => {
          snapshotChange('Edit text layer', () => { layer.text = value; });
        });
        appendInspectorField(subInspector, 'Color', layer.color || '#ffffff', 'color', (value) => {
          snapshotChange('Change text color', () => { layer.color = value; });
        });
        appendInspectorField(subInspector, 'Font size', layer.fontSize || 52, 'number', (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed > 0 && parsed <= 512) {
            snapshotChange('Change text size', () => { layer.fontSize = parsed; });
          }
        }, { min: 1, max: 512 });
      } else if (layer.kind === 'shape') {
        appendInspectorField(subInspector, 'Fill', layer.fillColor || '#0ea5e9', 'color', (value) => {
          snapshotChange('Change shape color', () => { layer.fillColor = value; });
        });
      } else if (layer.kind === 'adjustment') {
        const slider = document.createElement('label');
        slider.className = 'block text-[11px] text-zinc-400';
        slider.textContent = layer.adjType === 'invert' || layer.adjType === 'grayscale' ? 'Strength' : 'Amount';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = '-100';
        range.max = '100';
        range.value = String(layer.adjValue || 0);
        range.className = 'mt-1 w-full accent-sky-500';
        range.addEventListener('change', () => snapshotChange('Adjust layer', () => { layer.adjValue = Number(range.value); }));
        slider.append(range);
        subInspector.append(slider);
      }

      if (layer.maskAssetId) {
        const maskStatus = document.createElement('p');
        maskStatus.className = 'text-[10px] text-amber-300';
        maskStatus.textContent = `Layer mask ${layer.maskEnabled === false ? 'disabled' : 'enabled'}`;
        const toggleMask = document.createElement('button');
        toggleMask.type = 'button';
        toggleMask.className = 'rounded bg-[#232834] px-2 py-1 text-[10px] text-zinc-200 hover:bg-[#343b49]';
        toggleMask.textContent = layer.maskEnabled === false ? 'Enable mask' : 'Disable mask';
        toggleMask.addEventListener('click', () => snapshotChange('Toggle layer mask', () => {
          layer.maskEnabled = layer.maskEnabled === false;
        }));
        subInspector.append(maskStatus, toggleMask);
      }
    }

    function syncTransformInputs() {
      const layer = getSelectedLayer();
      if (!layer) return;
      document.getElementById('num-x').value = String(Math.round(layer.transform.x));
      document.getElementById('num-y').value = String(Math.round(layer.transform.y));
      document.getElementById('num-scale').value = String(Math.round(layer.transform.scale * 100));
      document.getElementById('num-rot').value = String(Math.round(layer.transform.rotation));
    }

    function renderAll() {
      compositeDocumentToCanvas(compositeCanvas);
      updateStageTransform();
      renderOverlay();
      updateHistogram();
      renderLayerList();
      renderInspector();
      updateHistoryUI();
      document.getElementById('btn-del-layer').disabled = !getSelectedLayer();
      document.getElementById('selection-status-badge').classList.toggle('hidden', !state.hasSelection);
    }

    function setActiveTool(toolId) {
      const tool = TOOLS.find((item) => item.id === toolId && item.available);
      if (!tool) return;
      state.activeTool = tool.id;
      document.getElementById('active-tool-badge').textContent = `TOOL: ${tool.label} (${tool.shortcut})`;
      const brushOptions = document.getElementById('tool-brush-options');
      const selectionOptions = document.getElementById('tool-selection-options');
      const showBrush = tool.id === 'brush' || tool.id === 'eraser';
      const showSelection = ['marquee-rect', 'marquee-ellipse', 'lasso', 'wand'].includes(tool.id);
      brushOptions.classList.toggle('hidden', !showBrush);
      brushOptions.classList.toggle('flex', showBrush);
      selectionOptions.classList.toggle('hidden', !showSelection);
      selectionOptions.classList.toggle('flex', showSelection);
      pasteboard.style.cursor = tool.id === 'move' ? 'default' : tool.id === 'hand' ? 'grab' : 'crosshair';
      buildToolbar();
    }

    function buildToolbar() {
      const host = document.getElementById('left-toolbar');
      host.replaceChildren();
      TOOLS.forEach((tool) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.disabled = !tool.available;
        button.title = tool.available ? `${tool.label} (${tool.shortcut})` : `${tool.label} — ${tool.reason}`;
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', String(state.activeTool === tool.id));
        button.className = `relative w-9 h-9 rounded flex items-center justify-center transition ${
          state.activeTool === tool.id
            ? 'bg-sky-600 text-white shadow'
            : tool.available
              ? 'text-zinc-300 hover:bg-[#232834]'
              : 'opacity-35 cursor-not-allowed text-zinc-500'
        }`;
        const icon = document.createElement('i');
        icon.setAttribute('data-lucide', tool.icon);
        icon.className = 'w-4 h-4';
        button.append(icon);
        button.addEventListener('click', () => setActiveTool(tool.id));
        host.append(button);
      });
      if (window.lucide?.createIcons) window.lucide.createIcons();
    }

    function setDockTab(tabName) {
      document.querySelectorAll('.dock-tab').forEach((button) => {
        const selected = button.dataset.tab === tabName;
        button.classList.toggle('border-b-2', selected);
        button.classList.toggle('border-sky-500', selected);
        button.classList.toggle('text-white', selected);
        button.classList.toggle('text-zinc-400', !selected);
        document.getElementById(`tab-${button.dataset.tab}`).classList.toggle('hidden', !selected);
      });
    }

    function openModal(id) {
      const modal = document.getElementById(id);
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }

    function closeModal(id) {
      const modal = document.getElementById(id);
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    function createNewDocument() {
      const name = document.getElementById('new-doc-name').value.trim() || 'Untitled';
      const width = Number(document.getElementById('new-doc-w').value);
      const height = Number(document.getElementById('new-doc-h').value);
      const background = document.getElementById('new-doc-bg').value;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
          width > 16384 || height > 16384 || width * height > 64_000_000) {
        showBanner('Document size must be between 1 and 16,384 px per side and at most 64 megapixels.', true);
        return;
      }
      AssetStore.clear();
      state.doc = {
        id: `doc-${Date.now()}`,
        name,
        schemaVersion: 1,
        width,
        height,
        background,
        layers: []
      };
      state.selectedLayerId = null;
      state.hasSelection = false;
      state.selectionMask = null;
      History.undoStack = [];
      History.redoStack = [];
      fitDocument();
      closeModal('modal-new-doc');
      renderAll();
      triggerIndexedDBAutosave();
    }

    function toggleSelection() {
      if (!state.hasSelection || !state.selectionMask) return;
      const snapshot = History.captureSnapshot('Invert Selection');
      state.selectionMask = state.selectionMask.map((value) => value > 127 ? 0 : 255);
      History.pushBeforeState(snapshot);
      renderAll();
    }

    function clearSelection() {
      if (!state.hasSelection) return;
      const snapshot = History.captureSnapshot('Deselect');
      state.hasSelection = false;
      state.selectionMask = null;
      History.pushBeforeState(snapshot);
      renderAll();
    }

    function deleteSelectedLayer() {
      const index = state.doc.layers.findIndex((layer) => layer.id === state.selectedLayerId);
      if (index < 0) return;
      const layer = state.doc.layers[index];
      const snapshot = History.captureSnapshot(`Delete "${layer.name}"`);
      state.doc.layers.splice(index, 1);
      state.selectedLayerId = state.doc.layers[Math.min(index, state.doc.layers.length - 1)]?.id || null;
      History.pushBeforeState(snapshot);
      renderAll();
    }

    async function addGeneratedImage(blob) {
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width * bitmap.height > 64_000_000) {
        bitmap.close();
        throw new Error('Generated image exceeds the 64 megapixel document memory limit.');
      }
      const snapshot = History.captureSnapshot('Generate AI image');
      const assetId = `asset-ai-${Date.now()}`;
      const canvas = createOffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close();
      AssetStore.set(assetId, canvas);
      const layer = {
        id: `layer-ai-${Date.now()}`,
        kind: 'image',
        name: 'AI Generated Image',
        assetId,
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'source-over',
        transform: {
          x: Math.round((state.doc.width - canvas.width) / 2),
          y: Math.round((state.doc.height - canvas.height) / 2),
          scale: 1,
          rotation: 0
        },
        maskAssetId: null,
        maskEnabled: true
      };
      state.doc.layers.push(layer);
      state.selectedLayerId = layer.id;
      History.pushBeforeState(snapshot);
      renderAll();
    }

    async function refreshAIStatus() {
      const title = document.getElementById('ai-status-title');
      const detail = document.getElementById('ai-status-detail');
      try {
        const status = await window.AIClient.getStatus();
        title.textContent = status.available ? 'Cloudflare Workers AI ready' : 'AI service not configured';
        detail.textContent = status.available
          ? `Ready to generate with ${status.model}. Your prompt is sent only when you choose Generate.`
          : 'Deploy the Cloudflare Worker and configure its Workers AI and rate-limit bindings to enable image generation.';
      } catch (error) {
        title.textContent = 'AI service unavailable';
        detail.textContent = error.message;
      }
    }

    async function generateAIImage() {
      const promptInput = document.getElementById('ai-image-prompt');
      const status = document.getElementById('ai-generation-status');
      const button = document.getElementById('btn-ai-generate');
      const prompt = promptInput.value.trim();
      if (!prompt) {
        status.textContent = 'Enter a prompt before generating an image.';
        promptInput.focus();
        return;
      }
      button.disabled = true;
      status.textContent = 'Generating with Cloudflare Workers AI…';
      try {
        const image = await window.AIClient.generate(prompt);
        await addGeneratedImage(image);
        status.textContent = 'Image generated and added as a new layer.';
      } catch (error) {
        status.textContent = error.message;
        showBanner(`AI generation failed: ${error.message}`, true);
      } finally {
        button.disabled = false;
      }
    }

    function buildCommandPalette() {
      const commands = [
        ['Add Paint Layer', () => addPaintableRasterLayer()],
        ['Add Text Layer', () => addVectorTextLayer('Editable Text')],
        ['Add Shape Layer', () => addVectorShapeLayer()],
        ['Import Image', () => document.getElementById('file-import-input').click()],
        ['Invert Selection', toggleSelection],
        ['Deselect', clearSelection],
        ['Export PNG', () => exportCompositeImage('image/png', 'png')],
        ['Export JPG', () => exportCompositeImage('image/jpeg', 'jpg')],
        ['Fit Canvas', fitDocument],
        ['Undo', () => History.undo()],
        ['Redo', () => History.redo()]
      ];
      const search = document.getElementById('cmd-search-input');
      const list = document.getElementById('cmd-list');
      const render = () => {
        list.replaceChildren();
        const query = search.value.trim().toLowerCase();
        commands.filter(([label]) => label.toLowerCase().includes(query)).forEach(([label, action]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'w-full rounded px-3 py-2 text-left text-zinc-200 hover:bg-[#232834]';
          button.textContent = label;
          button.addEventListener('click', () => {
            closeModal('modal-cmd-palette');
            action();
          });
          list.append(button);
        });
      };
      search.addEventListener('input', render);
      document.getElementById('btn-cmd-palette').addEventListener('click', () => {
        openModal('modal-cmd-palette');
        search.value = '';
        render();
        search.focus();
      });
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') list.querySelector('button')?.click();
      });
    }

    function bindEditorControls() {
      document.getElementById('btn-new-doc').addEventListener('click', () => openModal('modal-new-doc'));
      document.getElementById('btn-cancel-new-doc').addEventListener('click', () => closeModal('modal-new-doc'));
      document.getElementById('btn-confirm-new-doc').addEventListener('click', createNewDocument);
      document.getElementById('btn-undo').addEventListener('click', () => History.undo());
      document.getElementById('btn-redo').addEventListener('click', () => History.redo());
      document.getElementById('btn-add-raster').addEventListener('click', () => addPaintableRasterLayer());
      document.getElementById('btn-add-text').addEventListener('click', () => addVectorTextLayer('Editable Text'));
      document.getElementById('btn-add-shape').addEventListener('click', () => addVectorShapeLayer());
      document.getElementById('btn-add-mask').addEventListener('click', attachOrConvertSelectionToLayerMask);
      document.getElementById('btn-del-layer').addEventListener('click', deleteSelectedLayer);
      document.querySelectorAll('.btn-add-adj').forEach((button) => {
        button.addEventListener('click', () => addAdjustmentLayer(button.dataset.adj));
      });
      document.querySelectorAll('.btn-run-filter').forEach((button) => {
        button.addEventListener('click', () => applyRasterFilterToSelectedLayer(button.dataset.filter));
      });
      document.querySelectorAll('.dock-tab').forEach((button) => {
        button.addEventListener('click', () => setDockTab(button.dataset.tab));
      });
      document.getElementById('btn-toggle-dock').addEventListener('click', (event) => {
        const isOpen = rightDock.classList.toggle('is-open');
        event.currentTarget.setAttribute('aria-expanded', String(isOpen));
      });
      document.getElementById('btn-zoom-out').addEventListener('click', () => zoomViewport(0.8));
      document.getElementById('btn-zoom-in').addEventListener('click', () => zoomViewport(1.25));
      document.getElementById('btn-zoom-100').addEventListener('click', () => {
        state.viewport.zoom = 1;
        state.viewport.panX = Math.round((pasteboard.clientWidth - state.doc.width) / 2);
        state.viewport.panY = Math.round((pasteboard.clientHeight - state.doc.height) / 2);
        updateStageTransform();
      });
      document.getElementById('btn-sel-invert').addEventListener('click', toggleSelection);
      document.getElementById('btn-sel-to-mask').addEventListener('click', attachOrConvertSelectionToLayerMask);
      document.getElementById('btn-sel-clear').addEventListener('click', clearSelection);
      document.getElementById('brush-color').addEventListener('input', (event) => { state.brush.color = event.target.value; });
      document.getElementById('brush-size').addEventListener('input', (event) => {
        state.brush.size = Number(event.target.value);
        document.getElementById('brush-size-val').textContent = `${state.brush.size}px`;
      });
      document.getElementById('brush-hardness').addEventListener('input', (event) => {
        state.brush.hardness = Number(event.target.value) / 100;
      });
      document.getElementById('brush-opacity').addEventListener('input', (event) => {
        state.brush.opacity = Number(event.target.value) / 100;
      });
      document.getElementById('paint-target-mask').addEventListener('change', (event) => {
        state.brush.paintMask = event.target.checked;
      });
      document.getElementById('wand-tolerance').addEventListener('input', (event) => {
        state.wandTolerance = Math.max(0, Math.min(255, Number(event.target.value) || 0));
      });
      document.getElementById('inp-layer-name').addEventListener('change', (event) => {
        const layer = getSelectedLayer();
        if (!layer) return;
        const snapshot = History.captureSnapshot('Rename layer');
        layer.name = event.target.value.trim() || 'Untitled Layer';
        History.pushBeforeState(snapshot);
        renderAll();
      });
      document.getElementById('inp-layer-blend').addEventListener('change', (event) => {
        const layer = getSelectedLayer();
        if (!layer) return;
        const snapshot = History.captureSnapshot('Change blend mode');
        layer.blendMode = event.target.value;
        History.pushBeforeState(snapshot);
        renderAll();
      });
      [
        ['num-x', 'x', (value) => Number(value)],
        ['num-y', 'y', (value) => Number(value)],
        ['num-scale', 'scale', (value) => Number(value) / 100],
        ['num-rot', 'rotation', (value) => Number(value)]
      ].forEach(([id, key, parse]) => {
        document.getElementById(id).addEventListener('change', (event) => {
          const layer = getSelectedLayer();
          if (!layer) return;
          const value = parse(event.target.value);
          if (!Number.isFinite(value) || (key === 'scale' && (value < 0.05 || value > 10))) {
            showBanner('Transform value is outside the supported range.', true);
            syncTransformInputs();
            return;
          }
          const snapshot = History.captureSnapshot(`Change layer ${key}`);
          layer.transform[key] = value;
          History.pushBeforeState(snapshot);
          renderAll();
        });
      });
      let opacitySnapshot = null;
      const opacityInput = document.getElementById('inp-layer-opacity');
      opacityInput.addEventListener('pointerdown', () => {
        if (getSelectedLayer()) opacitySnapshot = History.captureSnapshot('Change layer opacity');
      });
      opacityInput.addEventListener('keydown', (event) => {
        if (!opacitySnapshot && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) &&
            getSelectedLayer()) {
          opacitySnapshot = History.captureSnapshot('Change layer opacity');
        }
      });
      opacityInput.addEventListener('input', (event) => {
        const layer = getSelectedLayer();
        if (!layer) return;
        if (!opacitySnapshot) opacitySnapshot = History.captureSnapshot('Change layer opacity');
        layer.opacity = Number(event.target.value) / 100;
        document.getElementById('lbl-layer-opacity').textContent = `Opacity ${event.target.value}%`;
        compositeDocumentToCanvas(compositeCanvas);
      });
      opacityInput.addEventListener('change', (event) => {
        const layer = getSelectedLayer();
        if (!layer) return;
        if (opacitySnapshot) {
          History.pushBeforeState(opacitySnapshot);
          opacitySnapshot = null;
          renderAll();
        }
      });
      document.getElementById('btn-ai-generate').addEventListener('click', generateAIImage);

      document.querySelectorAll('.fixed.inset-0').forEach((modal) => {
        modal.addEventListener('click', (event) => {
          if (event.target === modal) closeModal(modal.id);
        });
      });
    }

    function zoomViewport(factor) {
      const previousZoom = state.viewport.zoom;
      state.viewport.zoom = Math.max(0.1, Math.min(8, Number((previousZoom * factor).toFixed(2))));
      const rect = pasteboard.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      state.viewport.panX = centerX - (centerX - state.viewport.panX) * (state.viewport.zoom / previousZoom);
      state.viewport.panY = centerY - (centerY - state.viewport.panY) * (state.viewport.zoom / previousZoom);
      updateStageTransform();
    }

    function bindKeyboardShortcuts() {
      let previousTool = null;
      window.addEventListener('keydown', (event) => {
        const target = event.target;
        const editing = target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
        if (event.key === 'Escape') {
          closeModal('modal-new-doc');
          closeModal('modal-cmd-palette');
        }
        if (event.code === 'Space' && !editing && !event.repeat) {
          previousTool = state.activeTool;
          setActiveTool('hand');
          event.preventDefault();
          return;
        }
        if (editing) {
          return;
        }
        const command = event.ctrlKey || event.metaKey;
        if (command && event.key.toLowerCase() === 's') {
          event.preventDefault();
          document.getElementById('btn-save-proj').click();
        } else if (command && event.key.toLowerCase() === 'o') {
          event.preventDefault();
          document.getElementById('btn-open-proj').click();
        } else if (command && event.key.toLowerCase() === 'n') {
          event.preventDefault();
          openModal('modal-new-doc');
        } else if (command && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          document.getElementById('btn-cmd-palette').click();
        } else if (command && event.key.toLowerCase() === 'z' && event.shiftKey) {
          event.preventDefault();
          History.redo();
        } else if (command && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          History.undo();
        } else if (command && event.key.toLowerCase() === 'y') {
          event.preventDefault();
          History.redo();
        } else if (command && event.key.toLowerCase() === 'd') {
          event.preventDefault();
          clearSelection();
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && getSelectedLayer()) {
          event.preventDefault();
          deleteSelectedLayer();
        } else if (!command && !event.altKey) {
          const tool = TOOLS.find((item) => item.available && item.shortcut.toLowerCase() === event.key.toLowerCase());
          if (tool) setActiveTool(tool.id);
        }
      });
      window.addEventListener('keyup', (event) => {
        if (event.code === 'Space' && previousTool) {
          setActiveTool(previousTool);
          previousTool = null;
        }
      });
      window.addEventListener('blur', () => {
        if (previousTool) {
          setActiveTool(previousTool);
          previousTool = null;
        }
      });
    }

    function initializeEditor() {
      bindEditorControls();
      buildCommandPalette();
      bindKeyboardShortcuts();
      buildToolbar();
      fitDocument();
      renderAll();
      refreshAIStatus();
      window.addEventListener('resize', handleViewportResize);
      window.setInterval(triggerIndexedDBAutosave, 30000);
    }

    function initializeWhenReady() {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeEditor, { once: true });
      } else {
        initializeEditor();
      }
    }

    initializeWhenReady();
