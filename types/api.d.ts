/** Public, credential-free contract exposed as plugin.api. */
export interface CloudReference {
  readonly v: 1;
  readonly provider: 'baidu';
  readonly accountId: string;
  readonly fileId: string;
  readonly kind: 'file' | 'folder';
  readonly path: string;
  readonly name: string;
}
export interface CloudMetadata extends CloudReference {
  readonly size?: number | null;
  readonly modifiedAt?: string | null;
  readonly revision?: string | null;
}
export interface RequestOptions { signal?: AbortSignal; }
export interface PageOptions extends RequestOptions { offset?: number; }
export interface CloudPage {
  folder: CloudReference;
  items: CloudMetadata[];
  nextOffset: number | null;
  truncated: boolean;
  scopeFiltered?: boolean;
}
export interface Opener {
  id: string; // "web" is reserved.
  label?: string;
  canOpen(ref: CloudReference): boolean;
  open(ref: CloudReference, options: RequestOptions): Promise<unknown> | unknown;
}
export interface MediaCoreHandoff {
  protocol: 'media-resource-handoff/v1';
  target: {type: 'work' | 'series'; uid: string};
  resources: Array<{
    kind: 'file' | 'folder'; provider: 'baidu'; title: string;
    identity: {scope: string; id: string}; link: string; location: string;
  }>;
}
export interface CloudReferenceApiV1 {
  readonly version: 1;
  readonly capabilities: {
    readonly providers: readonly ['baidu'];
    readonly browse: true; readonly serverSearch: true;
    readonly mediaPreview: false; readonly write: false;
  };
  listAccounts(): Promise<Array<{accountId: string; label: string}>>;
  pickResource(options?: RequestOptions & {folder?: CloudReference; intent?: 'pick' | 'browse'}): Promise<CloudReference | null>;
  browse(folder: CloudReference, options?: PageOptions): Promise<CloudPage>;
  search(folder: CloudReference, query: string, options?: PageOptions): Promise<CloudPage>;
  resolve(ref: CloudReference | string, options?: RequestOptions & {fresh?: boolean}): Promise<CloudMetadata>;
  open(ref: CloudReference | string, options?: RequestOptions & {opener?: string}): Promise<unknown>;
  toMarkdown(ref: CloudReference, label?: string): string;
  parseReference(uri: string): CloudReference;
  toMediaCoreHandoff(target: MediaCoreHandoff['target'], resources: CloudReference[]): MediaCoreHandoff;
  registerOpener(opener: Opener): () => void;
  diagnostics(): Record<string, unknown>;
}
