var d=Object.defineProperty;var p=(r,e,t)=>e in r?d(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t;var s=(r,e,t)=>p(r,typeof e!="symbol"?e+"":e,t);import{E as l}from"./cLlIXn7l.js";import{c}from"./_waXOR9c.js";const u=String.raw`
(function () {
	let pyodide = null;
	let pyodideReady = null;
	let stdout = null;
	let stderr = null;

	function post(message, transfer) {
		parent.postMessage(message, '*', transfer || []);
	}

	async function loadRuntime(packages) {
		stdout = null;
		stderr = null;
		pyodide = await loadPyodide({
			indexURL: self.__PYODIDE_INDEX_URL__ || '/pyodide/',
			stdout: function (text) {
				stdout = stdout ? stdout + text + '\n' : text + '\n';
			},
			stderr: function (text) {
				stderr = stderr ? stderr + text + '\n' : text + '\n';
			},
			packages: ['micropip']
		});
		pyodide.FS.mkdirTree('/mnt/uploads');
		await pyodide.pyimport('micropip').install(packages || []);
	}

	async function ensureRuntime(packages) {
		if (!pyodideReady) pyodideReady = loadRuntime(packages || []);
		await pyodideReady;
		if (packages && packages.length > 0) {
			await pyodide.pyimport('micropip').install(packages);
		}
	}

	function ensureDir(dir) {
		try {
			pyodide.FS.stat(dir);
		} catch {
			pyodide.FS.mkdirTree(dir);
		}
	}

	function upload(files, dir) {
		dir = dir || '/mnt/uploads';
		ensureDir(dir);
		for (const file of files || []) {
			pyodide.FS.writeFile(dir + '/' + file.name, new Uint8Array(file.data));
		}
	}

	function list(path) {
		const entries = [];
		try {
			const names = pyodide.FS.readdir(path).filter(function (name) {
				return name !== '.' && name !== '..';
			});
			for (const name of names) {
				try {
					const stat = pyodide.FS.stat(path + '/' + name);
					const isDir = pyodide.FS.isDir(stat.mode);
					entries.push({ name: name, type: isDir ? 'directory' : 'file', size: isDir ? 0 : stat.size });
				} catch {}
			}
		} catch {}
		return entries;
	}

	function remove(path) {
		try {
			const stat = pyodide.FS.stat(path);
			if (!pyodide.FS.isDir(stat.mode)) {
				pyodide.FS.unlink(path);
				return;
			}
			const names = pyodide.FS.readdir(path).filter(function (name) {
				return name !== '.' && name !== '..';
			});
			for (const name of names) remove(path + '/' + name);
			pyodide.FS.rmdir(path);
		} catch {}
	}

	function clean(value) {
		try {
			if (value == null) return null;
			if (['string', 'number', 'boolean'].includes(typeof value)) return value;
			if (typeof value === 'bigint') return value.toString();
			if (Array.isArray(value)) return value.map(clean);
			if (typeof value.toJs === 'function') {
				const converted = value.toJs();
				return typeof converted?.toJs === 'function' ? converted.toString() : clean(converted);
			}
			if (typeof value === 'object') {
				const out = {};
				for (const key in value) {
					if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = clean(value[key]);
				}
				return out;
			}
			return JSON.stringify(value);
		} catch (error) {
			return '[processResult error]: ' + (error && error.message ? error.message : String(error));
		}
	}

	async function patchMatplotlib() {
		await pyodide.runPythonAsync([
			'import base64',
			'import os',
			'from io import BytesIO',
			'os.environ["MPLBACKEND"] = "AGG"',
			'import matplotlib.pyplot',
			'_old_show = matplotlib.pyplot.show',
			'assert _old_show, "matplotlib.pyplot.show"',
			'def show(*, block=None):',
			// String.raw keeps \t as-is; the sandbox's JS parser turns it into a real tab
			'\tbuf = BytesIO()',
			'\tmatplotlib.pyplot.savefig(buf, format="png")',
			'\tbuf.seek(0)',
			'\timg_str = base64.b64encode(buf.read()).decode("utf-8")',
			'\tmatplotlib.pyplot.clf()',
			'\tbuf.close()',
			'\tprint(f"data:image/png;base64,{img_str}")',
			'matplotlib.pyplot.show = show'
		].join('\n'));
	}

	async function execute(id, code, files) {
		stdout = null;
		stderr = null;
		let result = null;
		if (files && files.length > 0) upload(files);
		try {
			if (code.includes('matplotlib') && 'matplotlib' in pyodide.loadedPackages) await patchMatplotlib();
			result = clean(await pyodide.runPythonAsync(code));
		} catch (error) {
			stderr = error && error.message ? error.message : String(error);
		}
		post({ id: id, result: result, stdout: stdout, stderr: stderr });
	}

	window.addEventListener('message', async function (event) {
		if (event.source !== parent) return;
		const data = event.data || {};
		const id = data.id;
		try {
			if (!data.type || data.type === 'execute') {
				await ensureRuntime(data.packages || []);
				await execute(id, data.code, data.files);
				return;
			}
			await ensureRuntime();
			switch (data.type) {
				case 'fs:upload':
					upload(data.files, data.dir);
					post({ id: id, type: data.type, success: true });
					break;
				case 'fs:list':
					post({ id: id, type: data.type, entries: list(data.path) });
					break;
				case 'fs:read':
					try {
						const buffer = pyodide.FS.readFile(data.path).buffer;
						post({ id: id, type: data.type, data: buffer }, [buffer]);
					} catch (error) {
						post({ id: id, type: data.type, error: error && error.message ? error.message : String(error) });
					}
					break;
				case 'fs:delete':
					remove(data.path);
					post({ id: id, type: data.type, success: true });
					break;
				case 'fs:mkdir':
					pyodide.FS.mkdirTree(data.path);
					post({ id: id, type: data.type, success: true });
					break;
				case 'fs:sync':
					post({ id: id, type: data.type, success: true });
					break;
			}
		} catch (error) {
			post({ id: id, stderr: error && error.message ? error.message : String(error) });
		}
	});
})();
`;var o;const i=`${((o=globalThis.location)==null?void 0:o.origin)??""}/pyodide/`,f=`<!doctype html><html><head><meta charset="utf-8"><script>window.__PYODIDE_INDEX_URL__=${JSON.stringify(i)}<\/script></head><body><script src="${i}pyodide.js"><\/script><script>${u}<\/script></body></html>`;class m{constructor(){s(this,"onmessage",null);s(this,"onerror",null);s(this,"iframe");s(this,"ready",!1);s(this,"queue",[]);s(this,"messageListeners",new Set);s(this,"errorListeners",new Set);s(this,"onWindowMessage");s(this,"onIframeLoad");s(this,"onIframeError");this.iframe=document.createElement("iframe"),this.iframe.setAttribute("sandbox","allow-scripts"),this.iframe.setAttribute("aria-hidden","true"),this.iframe.setAttribute("title","pyodide-sandbox"),this.iframe.style.display="none",this.iframe.srcdoc=f,this.onWindowMessage=e=>{var a;if(e.source!==this.iframe.contentWindow)return;const t={data:e.data};(a=this.onmessage)==null||a.call(this,t);for(const n of this.messageListeners)n(t)},this.onIframeLoad=()=>{this.ready=!0;for(const e of this.queue)this.post(e.message,e.transfer);this.queue=[]},this.onIframeError=e=>{var t;(t=this.onerror)==null||t.call(this,e);for(const a of this.errorListeners)a(e)},window.addEventListener("message",this.onWindowMessage),this.iframe.addEventListener("load",this.onIframeLoad,{once:!0}),this.iframe.addEventListener("error",this.onIframeError),document.body.appendChild(this.iframe)}postMessage(e,t=[]){this.ready?this.post(e,t):this.queue.push({message:e,transfer:t})}addEventListener(e,t){e==="message"?this.messageListeners.add(t):e==="error"&&this.errorListeners.add(t)}removeEventListener(e,t){e==="message"?this.messageListeners.delete(t):e==="error"&&this.errorListeners.delete(t)}terminate(){window.removeEventListener("message",this.onWindowMessage),this.iframe.removeEventListener("load",this.onIframeLoad),this.iframe.removeEventListener("error",this.onIframeError),this.messageListeners.clear(),this.errorListeners.clear(),this.onmessage=null,this.onerror=null,this.iframe.remove()}post(e,t){var a;(a=this.iframe.contentWindow)==null||a.postMessage(e,"*",t)}}function y(r){return new Worker(""+new URL("../workers/pyodide.worker-Bu3BkIcm.js",import.meta.url).href,{type:"module",name:r==null?void 0:r.name})}const w=()=>{var r,e;return(e=(r=l(c))==null?void 0:r.features)!=null&&e.enable_pyodide_file_persistence?new y:new m};export{w as c};
//# sourceMappingURL=BmQEDCx1.js.map
