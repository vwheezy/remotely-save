import * as path from "path";
import { FileStats, Vault } from "obsidian";
import { Buffer } from "buffer";
import * as crypto from "crypto";

import { Dropbox, DropboxResponse, files } from "dropbox";
export { Dropbox } from "dropbox";
import { RemoteItem } from "./baseTypes";
import {
  arrayBufferToBuffer,
  bufferToArrayBuffer,
  mkdirpInVault,
  getPathFolder,
  getFolderLevels,
  setToString,
} from "./misc";
import { decryptArrayBuffer, encryptArrayBuffer } from "./encrypt";
import { strict as assert } from "assert";

export interface DropboxConfig {
  accessToken: string;
  clientID: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  accountID: string;
  username: string;
}

export const DEFAULT_DROPBOX_CONFIG = {
  accessToken: "",
  clientID: process.env.DEFAULT_DROPBOX_APP_KEY,
  refreshToken: "",
  accessTokenExpiresInSeconds: 0,
  accessTokenExpiresAtTime: 0,
  accountID: "",
  username: "",
};

export const getDropboxPath = (fileOrFolderPath: string, vaultName: string) => {
  let key = fileOrFolderPath;
  if (!fileOrFolderPath.startsWith("/")) {
    // then this is original path in Obsidian
    key = `/${vaultName}/${fileOrFolderPath}`;
  }
  if (key.endsWith("/")) {
    key = key.slice(0, key.length - 1);
  }
  return key;
};

const getNormPath = (fileOrFolderPath: string, vaultName: string) => {
  if (
    !(
      fileOrFolderPath === `/${vaultName}` ||
      fileOrFolderPath.startsWith(`/${vaultName}/`)
    )
  ) {
    throw Error(`"${fileOrFolderPath}" doesn't starts with "/${vaultName}/"`);
  }
  return fileOrFolderPath.slice(`/${vaultName}/`.length);
};

const fromDropboxItemToRemoteItem = (
  x:
    | files.FileMetadataReference
    | files.FolderMetadataReference
    | files.DeletedMetadataReference,
  vaultName: string
): RemoteItem => {
  let key = getNormPath(x.path_display, vaultName);
  if (x[".tag"] === "folder" && !key.endsWith("/")) {
    key = `${key}/`;
  }

  if (x[".tag"] === "folder") {
    return {
      key: key,
      lastModified: undefined,
      size: 0,
      remoteType: "dropbox",
      etag: `${x.id}\t`,
    } as RemoteItem;
  } else if (x[".tag"] === "file") {
    return {
      key: key,
      lastModified: Date.parse(x.server_modified).valueOf(),
      size: x.size,
      remoteType: "dropbox",
      etag: `${x.id}\t${x.content_hash}`,
    } as RemoteItem;
  } else if (x[".tag"] === "deleted") {
    throw Error("do not support deleted tag");
  }
};

/**
 * Dropbox api doesn't return mtime for folders.
 * This is a try to assign mtime by using files in folder.
 * @param allFilesFolders
 * @returns
 */
const fixLastModifiedTimeInplace = (allFilesFolders: RemoteItem[]) => {
  if (allFilesFolders.length === 0) {
    return;
  }

  // sort by longer to shorter
  allFilesFolders.sort((a, b) => b.key.length - a.key.length);

  // a "map" from dir to mtime
  let potentialMTime = {} as Record<string, number>;

  // first sort pass, from buttom to up
  for (const item of allFilesFolders) {
    if (item.key.endsWith("/")) {
      // itself is a folder, and initially doesn't have mtime
      if (item.lastModified === undefined && item.key in potentialMTime) {
        // previously we gathered all sub info of this folder
        item.lastModified = potentialMTime[item.key];
      }
    }
    const parent = `${path.posix.dirname(item.key)}/`;
    if (item.lastModified !== undefined) {
      if (parent in potentialMTime) {
        potentialMTime[parent] = Math.max(
          potentialMTime[parent],
          item.lastModified
        );
      } else {
        potentialMTime[parent] = item.lastModified;
      }
    }
  }

  // second pass, from up to buttom.
  // fill mtime by parent folder or Date.Now() if still not available.
  // this is only possible if no any sub-folder-files recursively.
  // we do not sort the array again, just iterate over it by reverse
  // using good old for loop.
  for (let i = allFilesFolders.length - 1; i >= 0; --i) {
    const item = allFilesFolders[i];
    if (!item.key.endsWith("/")) {
      continue; // skip files
    }
    if (item.lastModified !== undefined) {
      continue; // don't need to deal with it
    }
    assert(!(item.key in potentialMTime));
    const parent = `${path.posix.dirname(item.key)}/`;
    if (parent in potentialMTime) {
      item.lastModified = potentialMTime[parent];
    } else {
      item.lastModified = Date.now().valueOf();
      potentialMTime[item.key] = item.lastModified;
    }
  }

  return allFilesFolders;
};

////////////////////////////////////////////////////////////////////////////////
// Dropbox authorization using PKCE
// see https://dropbox.tech/developers/pkce--what-and-why-
////////////////////////////////////////////////////////////////////////////////

const specialBase64Encode = (str: Buffer) => {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};
const sha256 = (buffer: string) => {
  return crypto.createHash("sha256").update(buffer).digest();
};

export const getCodeVerifierAndChallenge = () => {
  const codeVerifier = specialBase64Encode(crypto.randomBytes(32));
  // console.log(`Client generated code_verifier: ${codeVerifier}`);
  const codeChallenge = specialBase64Encode(sha256(codeVerifier));
  // console.log(`Client generated code_challenge: ${codeChallenge}`);
  return {
    verifier: codeVerifier,
    challenge: codeChallenge,
  };
};

export const getAuthUrl = (appKey: string, challenge: string) => {
  return `https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline`;
};

export interface DropboxSuccessAuthRes {
  access_token: string;
  token_type: "bearer";
  expires_in: string;
  refresh_token?: string;
  scope?: string;
  uid?: string;
  account_id?: string;
}

export const sendAuthReq = async (
  appKey: string,
  verifier: string,
  authCode: string
) => {
  const resp1 = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      code: authCode,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_id: appKey,
    }),
  });
  const resp2 = (await resp1.json()) as DropboxSuccessAuthRes;
  return resp2;
};

export const sendRefreshTokenReq = async (
  appKey: string,
  refreshToken: string
) => {
  console.log("start auto getting refreshed Dropbox access token.");
  const resp1 = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
    }),
  });
  const resp2 = (await resp1.json()) as DropboxSuccessAuthRes;
  console.log("finish auto getting refreshed Dropbox access token.");
  return resp2;
};

export const setConfigBySuccessfullAuthInplace = async (
  config: DropboxConfig,
  authRes: DropboxSuccessAuthRes,
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  console.log("start updating local info of Dropbox token");

  config.accessToken = authRes.access_token;
  config.accessTokenExpiresInSeconds = parseInt(authRes.expires_in);
  config.accessTokenExpiresAtTime =
    Date.now() + parseInt(authRes.expires_in) * 1000 - 10 * 1000;

  if (authRes.refresh_token !== undefined) {
    config.refreshToken = authRes.refresh_token;
  }
  if (authRes.refresh_token !== undefined) {
    config.accountID = authRes.account_id;
  }

  if (saveUpdatedConfigFunc !== undefined) {
    await saveUpdatedConfigFunc();
  }

  console.log("finish updating local info of Dropbox token");
};

////////////////////////////////////////////////////////////////////////////////
// Other usual common methods
////////////////////////////////////////////////////////////////////////////////

export class WrappedDropboxClient {
  dropboxConfig: DropboxConfig;
  vaultName: string;
  saveUpdatedConfigFunc: () => Promise<any>;
  dropbox: Dropbox;
  vaultFolderExists: boolean;
  constructor(
    dropboxConfig: DropboxConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<any>
  ) {
    this.dropboxConfig = dropboxConfig;
    this.vaultName = vaultName;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
    this.vaultFolderExists = false;
  }

  init = async () => {
    // check token
    if (
      this.dropboxConfig.accessToken === "" ||
      this.dropboxConfig.refreshToken === ""
    ) {
      throw Error("The user has not manually auth yet.");
    }
    const currentTs = Date.now();
    if (this.dropboxConfig.accessTokenExpiresAtTime > currentTs) {
      this.dropbox = new Dropbox({
        accessToken: this.dropboxConfig.accessToken,
      });
    } else {
      if (this.dropboxConfig.refreshToken === "") {
        throw Error(
          "We need to automatically refresh token but none is stored."
        );
      }
      const resp = await sendRefreshTokenReq(
        this.dropboxConfig.clientID,
        this.dropboxConfig.refreshToken
      );

      setConfigBySuccessfullAuthInplace(
        this.dropboxConfig,
        resp,
        this.saveUpdatedConfigFunc
      );
      this.dropbox = new Dropbox({
        accessToken: this.dropboxConfig.accessToken,
      });
    }

    // check vault folder
    // console.log(`checking remote has folder /${this.vaultName}`);
    if (this.vaultFolderExists) {
      // console.log(`already checked, /${this.vaultName} exist before`)
    } else {
      const res = await this.dropbox.filesListFolder({
        path: "",
        recursive: false,
      });
      for (const item of res.result.entries) {
        if (item.path_display === `/${this.vaultName}`) {
          this.vaultFolderExists = true;
          break;
        }
      }
      if (!this.vaultFolderExists) {
        console.log(`remote does not have folder /${this.vaultName}`);
        await this.dropbox.filesCreateFolderV2({
          path: `/${this.vaultName}`,
        });
        console.log(`remote folder /${this.vaultName} created`);
      } else {
        // console.log(`remote folder /${this.vaultName} exists`);
      }
    }

    return this.dropbox;
  };
}

/**
 * @param dropboxConfig
 * @returns
 */
export const getDropboxClient = (
  dropboxConfig: DropboxConfig,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>
) => {
  return new WrappedDropboxClient(
    dropboxConfig,
    vaultName,
    saveUpdatedConfigFunc
  );
};

export const getRemoteMeta = async (
  client: WrappedDropboxClient,
  fileOrFolderPath: string
) => {
  await client.init();
  if (fileOrFolderPath === "" || fileOrFolderPath === "/") {
    // filesGetMetadata doesn't support root folder
    // we instead try to list files
    // if no error occurs, we ensemble a fake result.
    const rsp = await client.dropbox.filesListFolder({
      path: `/${client.vaultName}`,
      recursive: false, // don't need to recursive here
    });
    if (rsp.status !== 200) {
      throw Error(JSON.stringify(rsp));
    }
    return {
      key: fileOrFolderPath,
      lastModified: undefined,
      size: 0,
      remoteType: "dropbox",
      etag: undefined,
    } as RemoteItem;
  }

  const key = getDropboxPath(fileOrFolderPath, client.vaultName);

  const rsp = await client.dropbox.filesGetMetadata({
    path: key,
  });
  if (rsp.status !== 200) {
    throw Error(JSON.stringify(rsp));
  }
  return fromDropboxItemToRemoteItem(rsp.result, client.vaultName);
};

export const uploadToRemote = async (
  client: WrappedDropboxClient,
  fileOrFolderPath: string,
  vault: Vault,
  isRecursively: boolean = false,
  password: string = "",
  remoteEncryptedKey: string = "",
  foldersCreatedBefore: Set<string> | undefined = undefined
) => {
  await client.init();

  let uploadFile = fileOrFolderPath;
  if (password !== "") {
    uploadFile = remoteEncryptedKey;
  }
  uploadFile = getDropboxPath(uploadFile, client.vaultName);

  const isFolder = fileOrFolderPath.endsWith("/");

  if (isFolder && isRecursively) {
    throw Error("upload function doesn't implement recursive function yet!");
  } else if (isFolder && !isRecursively) {
    // folder
    if (password === "") {
      // if not encrypted, mkdir a remote folder
      if (foldersCreatedBefore?.has(uploadFile)) {
        // created, pass
      } else {
        try {
          await client.dropbox.filesCreateFolderV2({
            path: uploadFile,
          });
          foldersCreatedBefore?.add(uploadFile);
        } catch (err) {
          if (err.status === 409) {
            // pass
            foldersCreatedBefore?.add(uploadFile);
          } else {
            throw err;
          }
        }
      }
      const res = await getRemoteMeta(client, uploadFile);
      return res;
    } else {
      // if encrypted, upload a fake file with the encrypted file name
      await client.dropbox.filesUpload({
        path: uploadFile,
        contents: "",
      });
      return await getRemoteMeta(client, uploadFile);
    }
  } else {
    // file
    // we ignore isRecursively parameter here
    const localContent = await vault.adapter.readBinary(fileOrFolderPath);
    let remoteContent = localContent;
    if (password !== "") {
      remoteContent = await encryptArrayBuffer(localContent, password);
    }
    // in dropbox, we don't need to create folders before uploading! cool!
    // TODO: filesUploadSession for larger files (>=150 MB)
    await client.dropbox.filesUpload({
      path: uploadFile,
      contents: remoteContent,
      mode: {
        ".tag": "overwrite",
      },
    });
    // we want to mark that parent folders are created
    if (foldersCreatedBefore !== undefined) {
      const dirs = getFolderLevels(uploadFile).map((x) =>
        getDropboxPath(x, client.vaultName)
      );
      for (const dir of dirs) {
        foldersCreatedBefore?.add(dir);
      }
    }
    return await getRemoteMeta(client, uploadFile);
  }
};

export const listFromRemote = async (
  client: WrappedDropboxClient,
  prefix?: string
) => {
  if (prefix !== undefined) {
    throw Error("prefix not supported (yet)");
  }
  await client.init();
  const res = await client.dropbox.filesListFolder({
    path: `/${client.vaultName}`,
    recursive: true,
  });
  if (res.status !== 200) {
    throw Error(JSON.stringify(res));
  }
  // console.log(res);
  const contents = res.result.entries;
  const unifiedContents = contents
    .filter((x) => x[".tag"] !== "deleted")
    .filter((x) => x.path_display !== `/${client.vaultName}`)
    .map((x) => fromDropboxItemToRemoteItem(x, client.vaultName));
  fixLastModifiedTimeInplace(unifiedContents);
  return {
    Contents: unifiedContents,
  };
};

const downloadFromRemoteRaw = async (
  client: WrappedDropboxClient,
  fileOrFolderPath: string
) => {
  await client.init();
  const key = getDropboxPath(fileOrFolderPath, client.vaultName);
  const rsp = await client.dropbox.filesDownload({
    path: key,
  });
  if ((rsp.result as any).fileBlob !== undefined) {
    // we get a Blob
    const content = (rsp.result as any).fileBlob as Blob;
    return await content.arrayBuffer();
  } else if ((rsp.result as any).fileBinary !== undefined) {
    // we get a Buffer
    const content = (rsp.result as any).fileBinary as Buffer;
    return bufferToArrayBuffer(content);
  } else {
    throw Error(`unknown rsp from dropbox download: ${rsp}`);
  }
};

export const downloadFromRemote = async (
  client: WrappedDropboxClient,
  fileOrFolderPath: string,
  vault: Vault,
  mtime: number,
  password: string = "",
  remoteEncryptedKey: string = ""
) => {
  const isFolder = fileOrFolderPath.endsWith("/");

  await mkdirpInVault(fileOrFolderPath, vault);

  // the file is always local file
  // we need to encrypt it

  if (isFolder) {
    // mkdirp locally is enough
    // do nothing here
  } else {
    let downloadFile = fileOrFolderPath;
    if (password !== "") {
      downloadFile = remoteEncryptedKey;
    }
    downloadFile = getDropboxPath(downloadFile, client.vaultName);
    const remoteContent = await downloadFromRemoteRaw(client, downloadFile);
    let localContent = remoteContent;
    if (password !== "") {
      localContent = await decryptArrayBuffer(remoteContent, password);
    }
    await vault.adapter.writeBinary(fileOrFolderPath, localContent, {
      mtime: mtime,
    });
  }
};

export const deleteFromRemote = async (
  client: WrappedDropboxClient,
  fileOrFolderPath: string,
  password: string = "",
  remoteEncryptedKey: string = ""
) => {
  if (fileOrFolderPath === "/") {
    return;
  }
  let remoteFileName = fileOrFolderPath;
  if (password !== "") {
    remoteFileName = remoteEncryptedKey;
  }
  remoteFileName = getDropboxPath(remoteFileName, client.vaultName);

  await client.init();
  try {
    await client.dropbox.filesDeleteV2({
      path: remoteFileName,
    });
  } catch (err) {
    console.error("some error while deleting");
    console.error(err);
  }
};

export const checkConnectivity = async (client: WrappedDropboxClient) => {
  try {
    const results = await getRemoteMeta(client, "/");
    if (results === undefined) {
      return false;
    }
    return true;
  } catch (err) {
    console.error("dropbox connectivity error:");
    console.error(err);
    return false;
  }
};

export const getUserDisplayName = async (client: WrappedDropboxClient) => {
  await client.init();
  const acct = await client.dropbox.usersGetCurrentAccount();
  return acct.result.name.display_name;
};

export const revokeAuth = async (client: WrappedDropboxClient) => {
  await client.init();
  await client.dropbox.authTokenRevoke();
};
