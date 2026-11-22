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

export default function BimViewer({ url, height = 420 }: { url: string; height?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ loading: boolean; progress: number; message: string; error: string }>({
    loading: true, progress: 0, message: '准备中…', error: '',
  });

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

    scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b8, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(80, 120, 60);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
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

        const rebar = emptyBucket();
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
          const target = isRebar ? rebar : concrete;
          for (let i = 0; i < mesh.geometries.size(); i += 1) {
            const placed = mesh.geometries.get(i);
            const geometry = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
            const vertexData = ifcApi.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indexData = ifcApi.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
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
        const rebarGeometry = buildGeometry(rebar);
        const box = new THREE.Box3();
        if (concreteGeometry) {
          const material = new THREE.MeshStandardMaterial({ color: 0x9fb0c3, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(concreteGeometry, material);
          root.add(mesh);
        }
        if (rebarGeometry) {
          const material = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.55, metalness: 0.25 });
          const mesh = new THREE.Mesh(rebarGeometry, material);
          root.add(mesh);
        }

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
    </div>
  );
}
