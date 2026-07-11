import { LruCache } from "../cache/lru";
import { TEXTURE_CACHE_BYTES, type Rect, type TileDoneMessage } from "../types";

interface RenderTexture {
  id: string;
  texture: WebGLTexture;
  rect: Rect;
  width: number;
  height: number;
  rgba: Uint8Array;
  revision: number;
  retained: boolean;
}

interface Transform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface RetainedScreenTransform {
  dx: number;
  dy: number;
  scale: number;
  anchorX: number;
  anchorY: number;
}

export class WebglTileRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly positionBuffer: WebGLBuffer;
  private readonly uvBuffer: WebGLBuffer;
  private readonly resolutionLocation: WebGLUniformLocation;
  private readonly textureLocation: WebGLUniformLocation;
  private readonly uvRectLocation: WebGLUniformLocation;
  private readonly cache: LruCache<string, RenderTexture>;
  private activeRevision = 0;
  private readonly retainedTransforms = new Map<number, Transform>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.positionBuffer = must(gl.createBuffer(), "position buffer");
    this.uvBuffer = must(gl.createBuffer(), "uv buffer");
    this.vao = must(gl.createVertexArray(), "vertex array");
    this.resolutionLocation = must(gl.getUniformLocation(this.program, "u_resolution"), "resolution uniform");
    this.textureLocation = must(gl.getUniformLocation(this.program, "u_texture"), "texture uniform");
    this.uvRectLocation = must(gl.getUniformLocation(this.program, "u_uvRect"), "UV rectangle uniform");
    this.cache = new LruCache(TEXTURE_CACHE_BYTES, (_key, value) => gl.deleteTexture(value.texture));
    this.configure();
  }

  get textureCount(): number {
    return this.cache.size;
  }

  get textureBytes(): number {
    return this.cache.bytes;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  setActiveRevision(revision: number): void {
    if (revision === this.activeRevision) return;
    const previousRevision = this.activeRevision;
    let retainedCount = 0;
    for (const id of this.cache.keys()) {
      const tile = this.cache.get(id);
      if (tile && tile.revision === previousRevision) {
        tile.retained = true;
        retainedCount += 1;
      }
    }
    this.activeRevision = revision;
    if (retainedCount > 0) this.retainedTransforms.set(previousRevision, identityTransform());
    recordDeepBench({ type: "activeRevisionChanged", previousRevision, revision, retainedCount });
  }

  applyRetainedPan(dx: number, dy: number): void {
    for (const transform of this.retainedTransforms.values()) {
      transform.offsetX += dx;
      transform.offsetY += dy;
    }
  }

  applyRetainedZoom(factor: number, anchorX: number, anchorY: number): void {
    for (const transform of this.retainedTransforms.values()) {
      transform.offsetX = anchorX + (transform.offsetX - anchorX) * factor;
      transform.offsetY = anchorY + (transform.offsetY - anchorY) * factor;
      transform.scale *= factor;
    }
  }

  applyRetainedTransform(transform: RetainedScreenTransform): void {
    if (Number.isFinite(transform.scale) && transform.scale > 0 && transform.scale !== 1) {
      this.applyRetainedZoom(transform.scale, transform.anchorX, transform.anchorY);
    }
    if (transform.dx !== 0 || transform.dy !== 0) this.applyRetainedPan(transform.dx, transform.dy);
    recordDeepBench({ type: "retainedTransformApplied", ...transform, retainedTransformCount: this.retainedTransforms.size });
  }

  uploadTile(result: TileDoneMessage): void {
    const uploadStartedAt = performance.now();
    recordDeepBench({
      type: "tileUploadStarted",
      tileId: result.tileId,
      revision: result.revision,
      renderMode: result.stats.renderMode,
      width: result.width,
      height: result.height,
      uploadStartedAt
    });
    const gl = this.gl;
    const texture = must(gl.createTexture(), "tile texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const rgba = new Uint8Array(result.rgba);
    const padded = padTextureRgba(rgba, result.width, result.height);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      result.width + 2,
      result.height + 2,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      padded
    );

    this.cache.set(
      result.tileId,
      {
        id: result.tileId,
        texture,
        rect: result.rect,
        width: result.width,
        height: result.height,
        rgba,
        revision: result.revision,
        retained: result.revision !== this.activeRevision
      },
      padded.byteLength + rgba.byteLength
    );
    const uploaded = this.cache.get(result.tileId);
    if (uploaded) this.synchronizeTextureBorders(uploaded);
    recordDeepBench({
      type: "tileUploadDone",
      tileId: result.tileId,
      revision: result.revision,
      renderMode: result.stats.renderMode,
      uploadStartedAt,
      uploadDoneAt: performance.now()
    });
  }

  pruneRetainedWhenActiveCoverage(minActiveTiles: number): void {
    const active = this.tiles().filter((tile) => tile.revision === this.activeRevision).length;
    if (active < minActiveTiles) return;
    for (const id of this.cache.keys()) {
      const tile = this.cache.get(id);
      if (tile && tile.revision < this.activeRevision) this.cache.delete(id);
    }
    for (const revision of this.retainedTransforms.keys()) {
      if (revision < this.activeRevision) this.retainedTransforms.delete(revision);
    }
  }

  render(flush = false): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.006, 0.009, 0.014, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);
    gl.uniform1i(this.textureLocation, 0);
    gl.activeTexture(gl.TEXTURE0);

    const retained = this.tiles()
      .filter((tile) => tile.revision < this.activeRevision)
      .sort((a, b) => a.revision - b.revision);
    const active = this.tiles()
      .filter((tile) => tile.revision === this.activeRevision)
      .sort((a, b) => tileArea(b) - tileArea(a));
    for (const tile of retained) this.drawTile(tile, this.retainedTransforms.get(tile.revision) ?? identityTransform());
    for (const tile of active) this.drawTile(tile, identityTransform());
    if (flush && retained.length > 0) {
      const retainedFrame = {
        revision: this.activeRevision,
        retainedCount: retained.length,
        activeCount: active.length,
        now: performance.now()
      };
      (globalThis as unknown as { __mandelbrotLastRetainedFrame?: typeof retainedFrame }).__mandelbrotLastRetainedFrame = retainedFrame;
      recordDeepBench({ type: "retainedFrameRendered", ...retainedFrame });
    }
    if (flush) gl.flush();
  }

  private configure(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private drawTile(tile: RenderTexture, transform: Transform): void {
    const gl = this.gl;
    const rect = transformRect(tile.rect, transform);
    gl.bindTexture(gl.TEXTURE_2D, tile.texture);
    gl.uniform4f(
      this.uvRectLocation,
      1 / (tile.width + 2),
      1 / (tile.height + 2),
      tile.width / (tile.width + 2),
      tile.height / (tile.height + 2)
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        rect.x,
        rect.y,
        rect.x + rect.width,
        rect.y,
        rect.x,
        rect.y + rect.height,
        rect.x,
        rect.y + rect.height,
        rect.x + rect.width,
        rect.y,
        rect.x + rect.width,
        rect.y + rect.height
      ]),
      gl.DYNAMIC_DRAW
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private synchronizeTextureBorders(tile: RenderTexture): void {
    for (const other of this.tiles()) {
      if (other === tile || other.revision !== tile.revision) continue;
      if (sameSpan(tile.rect.x, tile.rect.width, other.rect.x, other.rect.width) && tile.width === other.width) {
        if (touchesAfter(tile.rect.y, tile.rect.height, other.rect.y)) {
          this.connectHorizontalTextures(tile, other);
        } else if (touchesAfter(other.rect.y, other.rect.height, tile.rect.y)) {
          this.connectHorizontalTextures(other, tile);
        }
      }
      if (sameSpan(tile.rect.y, tile.rect.height, other.rect.y, other.rect.height) && tile.height === other.height) {
        if (touchesAfter(tile.rect.x, tile.rect.width, other.rect.x)) {
          this.connectVerticalTextures(tile, other);
        } else if (touchesAfter(other.rect.x, other.rect.width, tile.rect.x)) {
          this.connectVerticalTextures(other, tile);
        }
      }
    }
  }

  private connectHorizontalTextures(top: RenderTexture, bottom: RenderTexture): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, top.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 1, top.height + 1, top.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, textureRow(bottom, 0));
    gl.bindTexture(gl.TEXTURE_2D, bottom.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 1, 0, bottom.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, textureRow(top, top.height - 1));
  }

  private connectVerticalTextures(left: RenderTexture, right: RenderTexture): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, left.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, left.width + 1, 1, 1, left.height, gl.RGBA, gl.UNSIGNED_BYTE, textureColumn(right, 0));
    gl.bindTexture(gl.TEXTURE_2D, right.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, 1, right.height, gl.RGBA, gl.UNSIGNED_BYTE, textureColumn(left, left.width - 1));
  }

  private tiles(): RenderTexture[] {
    return this.cache.keys().map((key) => this.cache.get(key)).filter((tile): tile is RenderTexture => Boolean(tile));
  }
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = must(gl.createProgram(), "shader program");
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Failed to link shader program");
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = must(gl.createShader(type), "shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "Failed to compile shader");
  }
  return shader;
}

function must<T>(value: T | null, label: string): T {
  if (!value) throw new Error(`Unable to create ${label}`);
  return value;
}

function identityTransform(): Transform {
  return { offsetX: 0, offsetY: 0, scale: 1 };
}

function transformRect(rect: Rect, transform: Transform): Rect {
  return {
    x: rect.x * transform.scale + transform.offsetX,
    y: rect.y * transform.scale + transform.offsetY,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale
  };
}

function tileArea(tile: RenderTexture): number {
  return tile.rect.width * tile.rect.height;
}

function padTextureRgba(source: Uint8Array, width: number, height: number): Uint8Array {
  const paddedWidth = width + 2;
  const padded = new Uint8Array(paddedWidth * (height + 2) * 4);
  for (let y = 0; y < height + 2; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, y - 1));
    for (let x = 0; x < width + 2; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, x - 1));
      const sourceOffset = (sourceY * width + sourceX) * 4;
      padded.set(source.subarray(sourceOffset, sourceOffset + 4), (y * paddedWidth + x) * 4);
    }
  }
  return padded;
}

function textureRow(texture: RenderTexture, y: number): Uint8Array {
  return texture.rgba.subarray(y * texture.width * 4, (y + 1) * texture.width * 4);
}

function textureColumn(texture: RenderTexture, x: number): Uint8Array {
  const column = new Uint8Array(texture.height * 4);
  for (let y = 0; y < texture.height; y += 1) {
    const sourceOffset = (y * texture.width + x) * 4;
    column.set(texture.rgba.subarray(sourceOffset, sourceOffset + 4), y * 4);
  }
  return column;
}

function sameSpan(start: number, span: number, otherStart: number, otherSpan: number): boolean {
  return Math.abs(start - otherStart) < 0.01 && Math.abs(span - otherSpan) < 0.01;
}

function touchesAfter(start: number, span: number, otherStart: number): boolean {
  return Math.abs(start + span - otherStart) < 0.01;
}

function recordDeepBench(event: Record<string, unknown>): void {
  (globalThis as unknown as { __deepBenchRecord?: (event: Record<string, unknown>) => void }).__deepBenchRecord?.(event);
}

const vertexSource = `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
uniform vec2 u_resolution;
out vec2 v_uv;

void main() {
  vec2 zeroToOne = a_position / u_resolution;
  vec2 clip = zeroToOne * 2.0 - 1.0;
  gl_Position = vec4(clip * vec2(1.0, -1.0), 0.0, 1.0);
  v_uv = a_uv;
}
`;

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform vec4 u_uvRect;
in vec2 v_uv;
out vec4 out_color;

void main() {
  vec2 uv = u_uvRect.xy + v_uv * u_uvRect.zw;
  vec2 textureSizePx = vec2(textureSize(u_texture, 0));
  vec2 texelPosition = uv * textureSizePx - 0.5;
  vec2 texelBase = floor(texelPosition);
  vec2 weight = fract(texelPosition);
  weight = weight * weight * (3.0 - 2.0 * weight);
  vec2 sampleUv = (texelBase + weight + 0.5) / textureSizePx;
  vec2 texel = 1.0 / textureSizePx;
  vec4 center = texture(u_texture, sampleUv);
  vec4 north = texture(u_texture, sampleUv - vec2(0.0, texel.y));
  vec4 south = texture(u_texture, sampleUv + vec2(0.0, texel.y));
  vec4 west = texture(u_texture, sampleUv - vec2(texel.x, 0.0));
  vec4 east = texture(u_texture, sampleUv + vec2(texel.x, 0.0));
  vec4 blur = (north + south + west + east) * 0.25;
  float contrast = max(max(length(center.rgb - north.rgb), length(center.rgb - south.rgb)),
                       max(length(center.rgb - west.rgb), length(center.rgb - east.rgb)));
  float sharpen = smoothstep(0.035, 0.22, contrast) * 0.8;
  out_color = vec4(clamp(center.rgb + (center.rgb - blur.rgb) * sharpen, 0.0, 1.0), center.a);
}
`;
