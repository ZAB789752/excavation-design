import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './bim-viewer.css';

type Bucket = {
  pos: Float32Array[];
  nrm: Float32Array[];
  idx: Uint32Array[];
  base: number;
};

const emptyBucket = (): Bucket => ({ pos: [], nrm: [], idx: [], base: 0 });

type ViewMode = 'solid' | 'xray' | 'rebar';

const VIEW_MODES: { key: ViewMode; label: string; hint: string }[] = [
  { key: 'solid', label: '实体', hint: '混凝土不透明，只看外观' },
  { key: 'xray', label: '透视', hint: '混凝土半透明，钢筋笼可见' },
  { key: 'rebar', label: '只看钢筋', hint: '隐藏混凝土，完整查看钢筋' },
];

// 与 app/ifc/exporter.py 里三种 IfcSurfaceStyle 的 RGB 对应
const REBAR_LEGEND = [
  { color: '#b84333', label: '主筋' },
  { color: '#0d7394', label: '箍筋' },
  { color: '#d9991a', label: '加强箍' },
];

export default function BimViewer({ url, height = 420 }: { url: string; height?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ loading: boolean; progress: number; message: string; error: string }>({
    loading: true, progress: 0, message: '准备中…', error: '',
  });
  // 混凝土不透明时会完整包住桩/墙/梁内的钢筋笼，导致导出再多钢筋也看不到。
  // 默认透视，允许一键切换实体 / 只看钢筋。
  const [viewMode, setViewMode] = useState<ViewMode>('xray');
  const modeRef = useRef<ViewMode>('xray');
  const applyModeRef = useRef<(mode: ViewMode) => void>(() => {});
  const concreteMeshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7fafc);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // 之前三盏灯合计 3.35 强度，钢筋的深色被推到接近纯白，分色完全失效
    scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b8, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(80, 120, 60);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.22);
    fill.position.set(-60, 40, -80);
    scene.add(fill);

    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);

    const grid = new THREE.GridHelper(200, 40, 0xd7e0ea, 0xeef2f7);
    grid.position.y = -0.01;
    scene.add(grid);

    let disposed = false;
    let frame = 0;
    let api: { CloseModel: (id: number) => void } | null = null;
    let modelID = -1;

    const resize = () => {
      const width = host.clientWidth || 640;
      const h = host.clientHeight || height;
      renderer.setSize(width, h, false);
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const tick = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    const buildGeometry = (bucket: Bucket) => {
      if (!bucket.pos.length) return null;
      const vertexCount = bucket.pos.reduce((sum, arr) => sum + arr.length, 0);
      const indexCount = bucket.idx.reduce((sum, arr) => sum + arr.length, 0);
      const positions = new Float32Array(vertexCount);
      const normals = new Float32Array(vertexCount);
      const indices = new Uint32Array(indexCount);
      let po = 0;
      let io = 0;
      bucket.pos.forEach((arr) => { positions.set(arr, po); po += arr.length; });
      let no = 0;
      bucket.nrm.forEach((arr) => { normals.set(arr, no); no += arr.length; });
      bucket.idx.forEach((arr) => { indices.set(arr, io); io += arr.length; });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return geometry;
    };

    const run = async () => {
      try {
        setStatus({ loading: true, progress: 3, message: '加载 IFC 解析器…', error: '' });
        const ifc = await import('web-ifc');
        const ifcApi = new ifc.IfcAPI();
        ifcApi.SetWasmPath('/wasm/');
        await ifcApi.Init();
        if (disposed) return;

        setStatus({ loading: true, progress: 10, message: '下载模型文件…', error: '' });
        const response = await fetch(url);
        if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (disposed) return;

        setStatus({ loading: true, progress: 22, message: `解析 IFC（${(buffer.byteLength / 1048576).toFixed(1)} MB）…`, error: '' });
        modelID = ifcApi.OpenModel(buffer);
        api = ifcApi;
        const rebarIds = new Set<number>(Array.from(ifcApi.GetLineIDsWithType(modelID, ifc.IFCREINFORCINGBAR)));

        const rebarBuckets = new Map<string, { bucket: Bucket; color: THREE.Color }>();
        const rebarBucketFor = (color: { x: number; y: number; z: number }, hasColor: boolean) => {
          const key = hasColor ? `${color.x.toFixed(3)},${color.y.toFixed(3)},${color.z.toFixed(3)}` : 'default';
          let item = rebarBuckets.get(key);
          if (!item) {
            item = {
              bucket: emptyBucket(),
              color: hasColor
                ? new THREE.Color().setRGB(color.x, color.y, color.z)
                : new THREE.Color(0xb45309),
            };
            rebarBuckets.set(key, item);
          }
          return item.bucket;
        };
        const concrete = emptyBucket();
        const matrix = new THREE.Matrix4();
        const normalMatrix = new THREE.Matrix3();
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();

        const add = (bucket: Bucket, vertexData: Float32Array, indexData: Uint32Array, transform: number[]) => {
          matrix.fromArray(transform);
          normalMatrix.getNormalMatrix(matrix);
          const count = vertexData.length / 6;
          const positions = new Float32Array(count * 3);
          const normals = new Float32Array(count * 3);
          for (let i = 0; i < count; i += 1) {
            point.set(vertexData[i * 6], vertexData[i * 6 + 1], vertexData[i * 6 + 2]).applyMatrix4(matrix);
            positions[i * 3] = point.x; positions[i * 3 + 1] = point.y; positions[i * 3 + 2] = point.z;
            normal.set(vertexData[i * 6 + 3], vertexData[i * 6 + 4], vertexData[i * 6 + 5]).applyMatrix3(normalMatrix).normalize();
            normals[i * 3] = normal.x; normals[i * 3 + 1] = normal.y; normals[i * 3 + 2] = normal.z;
          }
          const indices = new Uint32Array(indexData.length);
          for (let i = 0; i < indexData.length; i += 1) indices[i] = indexData[i] + bucket.base;
          bucket.base += count;
          bucket.pos.push(positions);
          bucket.nrm.push(normals);
          bucket.idx.push(indices);
        };

        let processed = 0;
        let total = 1;
        ifcApi.StreamAllMeshes(modelID, (mesh, index, sum) => {
          if (disposed) return;
          total = sum || total;
          processed = index + 1;
          const isRebar = rebarIds.has(mesh.expressID);
          for (let i = 0; i < mesh.geometries.size(); i += 1) {
            const placed = mesh.geometries.get(i);
            const geometry = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
            const vertexData = ifcApi.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indexData = ifcApi.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            const target = isRebar ? rebarBucketFor(placed.color, placed.hasColor) : concrete;
            add(target, vertexData, indexData, placed.flatTransformation as unknown as number[]);
            geometry.delete();
          }
          if (processed % 200 === 0 || processed === total) {
            const ratio = Math.min(0.96, processed / Math.max(total, 1));
            setStatus({ loading: true, progress: 25 + ratio * 70, message: `生成几何 ${processed}/${total}`, error: '' });
          }
        });

        if (disposed) return;
        setStatus({ loading: true, progress: 97, message: '构建场景…', error: '' });

        const concreteGeometry = buildGeometry(concrete);
        const box = new THREE.Box3();
        const applyMode = (mode: ViewMode) => {
          const mesh = concreteMeshRef.current;
          if (!mesh) return;
          const material = mesh.material as THREE.MeshStandardMaterial;
          const solid = mode === 'solid';
          material.transparent = !solid;
          material.opacity = solid ? 1 : 0.07;
          material.depthWrite = solid;
          material.needsUpdate = true;
          mesh.visible = mode !== 'rebar';
        };
        applyModeRef.current = applyMode;
        if (concreteGeometry) {
          const material = new THREE.MeshStandardMaterial({
            color: 0xb9c6d6, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide,
            transparent: true, opacity: 0.07, depthWrite: false,
          });
          const mesh = new THREE.Mesh(concreteGeometry, material);
          concreteMeshRef.current = mesh;
          root.add(mesh);
        }
        // 主筋/箍筋/加强箍在 IFC 里各带一种材质色，按颜色分开建 mesh 才能看出层次
        rebarBuckets.forEach(({ bucket, color }) => {
          const geometry = buildGeometry(bucket);
          if (!geometry) return;
          const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 });
          root.add(new THREE.Mesh(geometry, material));
        });
        rebarBuckets.clear();

        root.updateMatrixWorld(true);
        box.setFromObject(root);

        if (box.isEmpty()) {
          setStatus({ loading: false, progress: 100, message: '模型没有可显示的几何', error: '' });
          return;
        }
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z, 1);
        grid.scale.setScalar(Math.max(radius / 60, 0.5));
        grid.position.set(center.x, box.min.y - 0.05, center.z);
        camera.position.set(center.x + radius * 0.8, center.y + radius * 0.55, center.z + radius * 0.9);
        camera.near = radius / 200;
        camera.far = radius * 20;
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();

        applyMode(modeRef.current);
        setStatus({ loading: false, progress: 100, message: `已加载 · 钢筋 ${rebarIds.size.toLocaleString()} 根`, error: '' });
      } catch (err) {
        if (!disposed) {
          setStatus({ loading: false, progress: 0, message: '', error: err instanceof Error ? err.message : String(err) });
        }
      }
    };

    void run();

    return () => {
      disposed = true;
      concreteMeshRef.current = null;
      applyModeRef.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (api && modelID >= 0) {
        try { api.CloseModel(modelID); } catch { /* 关闭失败不阻塞卸载 */ }
      }
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [url, height]);

  return (
    <div className="bimViewer" style={{ height }}>
      <div className="bimViewerHost" ref={hostRef} />
      {status.loading ? (
        <div className="bimViewerOverlay">
          <div className="bimViewerBar"><span style={{ width: `${Math.max(4, Math.min(100, status.progress))}%` }} /></div>
          <p>{status.message}</p>
          <small>首次解析大模型需要 20–60 秒，之后浏览器会缓存</small>
        </div>
      ) : null}
      {status.error ? (
        <div className="bimViewerOverlay error">
          <p>{status.error}</p>
          <small>可先下载 IFC 到本地，用 BIM Vision 或 BlenderBIM 打开</small>
        </div>
      ) : null}
      {!status.loading && !status.error ? <div className="bimViewerBadge">{status.message}</div> : null}
      {!status.loading && !status.error ? (
        <div className="bimViewerLegend">
          {REBAR_LEGEND.map((item) => (
            <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>
          ))}
          <em>滚轮缩放 · 拖动旋转 · 右键平移</em>
        </div>
      ) : null}
      {!status.loading && !status.error ? (
        <div className="bimViewerModes" role="group" aria-label="显示模式">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              title={mode.hint}
              className={viewMode === mode.key ? 'active' : ''}
              onClick={() => {
                modeRef.current = mode.key;
                setViewMode(mode.key);
                applyModeRef.current(mode.key);
              }}
            >
              {mode.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
