import { FastbootDevice } from './fastboot.js';
import * as common from './common.js';

const DB_VERSION = 1;

class BlobStore {
    constructor() {
        this.db = null;
    }

    async _wrapReq(request, onUpgrade = null) {
        return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                resolve(request.result);
            };
            request.oncomplete = (event) => {
                resolve(request.result);
            };
            request.onerror = (event) => {
                reject(event);
            };

            if (onUpgrade != null) {
                request.onupgradeneeded = onUpgrade;
            }
        });
    }

    async init() {
        this.db = await this._wrapReq(indexedDB.open(this.constructor.name, DB_VERSION), (event) => {
            let db = event.target.result;
            db.createObjectStore("files", { keyPath: "name" });
            /* no index needed for such a small database */
        });
    }

    async saveFile(name, blob) {
        this.db.transaction(["files"], "readwrite").objectStore("files").add({
            name: name,
            blob: blob,
        });
    }

    async loadFile(name) {
        try {
            let obj = await this._wrapReq(this.db.transaction("files").objectStore("files").get(name));
            return obj.blob;
        } catch (error) {
            return null;
        }
    }

    async close() {
        this.db.close();
    }
}

export async function downloadZip(url) {
    // Open the DB first to get user consent
    let store = new BlobStore();
    await store.init();

    let filename = url.split('/').pop();
    let blob = await store.loadFile(filename);
    console.log(blob);
    if (blob == null) {
        common.logDebug(`Downloading ${url}`);
        let resp = await fetch(new Request(url));
        blob = await resp.blob();
        common.logDebug('File downloaded, saving...');
        await store.saveFile(filename, blob);
        common.logDebug('File saved');
    } else {
        common.logDebug(`Loaded ${filename} from blob store, skipping download`);
    }

    store.close();
    return blob;
}

export async function flashZip(device, name) {
    zip.configure({
        workerScriptsPath: "/libs/",
    });

    let store = new BlobStore();
    await store.init();

    common.logDebug(`Loading ${name} as zip`);
    let reader = new zip.ZipReader(new zip.BlobReader(await store.loadFile(name)));
    let entries = await reader.getEntries();
    for (let entry of entries) {
        if (entry.filename.match(/avb_pkmd.bin$/)) {
            common.logDebug('Flashing AVB custom key');
            let blob = await entry.getData(new zip.BlobWriter('application/octet-stream'));
            await device.flashBlob('avb_custom_key', blob);
        } else if (entry.filename.match(/bootloader-.+\.img$/)) {
            common.logDebug('Flashing bootloader image pack');
            let blob = await entry.getData(new zip.BlobWriter('application/octet-stream'));
            await device.flashBlob('bootloader', blob);
        } else if (entry.filename.match(/radio-.+\.img$/)) {
            common.logDebug('Flashing radio image pack');
            let blob = await entry.getData(new zip.BlobWriter('application/octet-stream'));
            await device.flashBlob('radio', blob);
        } else if (entry.filename.match(/image-.+\.zip$/)) {
            common.logDebug('Flashing images from nested images zip');
            let imagesBlob = await entry.getData(new zip.BlobWriter('application/zip'));
            let imageReader = new zip.ZipReader(new zip.BlobReader(imagesBlob));
            let imageEntries = await imageReader.getEntries();

            for (let image of imageEntries) {
                if (!image.filename.endsWith('.img')) {
                    continue;
                }

                common.logDebug(`Flashing ${image.filename} from images zip`);
                let partition = image.filename.replace('.img', '');
                let blob = await image.getData(new zip.BlobWriter('application/octet-stream'));
                await device.flashBlob(partition, blob);
            }
        }
    }

    store.close();
}