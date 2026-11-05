/**
 * Reseller-side records. Nothing in this module is an NXTL eSIM API resource.
 * The default store is in memory. JSON-file and SQL adapters are examples.
 */

import type { UsageSnapshot } from "./usage.js";

export type CustomerStatus = "active" | "flagged" | "suspended";

export interface Customer {
  id: string;
  externalId?: string;
  name?: string;
  email?: string;
  tags: string[];
  notes?: string;
  metadata: Record<string, unknown>;
  status: CustomerStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LineAssignment {
  id: string;
  customerId: string;
  iccid: string;
  label?: string;
  assignedAt: string;
  unassignedAt?: string;
  /** Set when the reseller suspends the customer. Renewal will not resume these lines. */
  manualPause?: boolean;
}

export type LedgerKind = "credit" | "debit" | "adjustment";

/** Prepaid wallet the reseller manages for a customer. This is not the NXTL pooled balance. */
export interface WalletEntry {
  id: string;
  customerId: string;
  at: string;
  kind: LedgerKind;
  amount: number;
  currency: string;
  memo?: string;
  reference?: string;
}

export interface SellablePackage {
  id: string;
  name: string;
  /** Data allowance in bytes (SI). */
  dataCapBytes: number;
  validityDays: number;
  /** ISO 3166-1 alpha-2. Empty means any country the usage row reports. */
  countries: string[];
  price: number;
  currency: string;
  /**
   * `flag` records overage in the store.
   * `suspend` also calls POST /esims/{iccid}/suspend when an ICCID is known.
   * The API has no byte-cap threshold. See `syncPackageThreshold`.
   */
  overage: "flag" | "suspend";
  /** Lower numbers are consumed first when allocation mode is `priority`. */
  priority: number;
  /**
   * Optional USD figure for line_usage_pct / line_usage_usd_today.
   * Current EUR usage has amount_usd 0, so this rule does not observe that charge.
   * The stored period does not select the evaluation window.
   */
  usdCap?: number;
  /** When true, renewal may resume the line. A manual reseller pause is left suspended. */
  resumeOnRenewal?: boolean;
}

export type AllocationStatus = "active" | "expired" | "exhausted" | "overage";

export interface PackageAllocation {
  id: string;
  customerId: string;
  packageId: string;
  iccid?: string;
  startsAt: string;
  expiresAt: string;
  consumedBytes: number;
  /** Extra bytes added by a reseller top-up. Added to the package cap. */
  bonusBytes?: number;
  status: AllocationStatus;
}

export interface StoredInvoice {
  id: string;
  customerId: string;
  currency: string;
  periodSince: string;
  periodUntil: string;
  total: number;
  wholesaleTotal: number;
  margin: number;
  issuedAt: string;
  document: Record<string, unknown>;
}

export interface CustomerFilter {
  tag?: string;
  status?: CustomerStatus;
  externalId?: string;
}

export interface AssignmentFilter {
  customerId?: string;
  iccid?: string;
  activeOnly?: boolean;
}

export interface AppliedKey {
  stream: "financial" | "volume" | "cdr" | "line_usage" | "webhook";
  key: string;
}

export interface SyncCheckpoint {
  scope: string;
  afterId: number;
}

export interface PendingDetail {
  scope: string;
  ledgerId: number;
  iccid: string;
  createdAt?: string;
}

export interface FailedAction {
  id: string;
  iccid: string;
  /** Customer the action was recorded for. Retries do not cross customers. */
  customerId?: string;
  kind: "suspend";
  error: string;
  at: string;
}

export interface SyncCommit {
  wallet?: WalletEntry[];
  applied?: AppliedKey[];
  allocations?: PackageAllocation[];
  checkpoints?: SyncCheckpoint[];
  pending?: PendingDetail[];
  clearPending?: Array<{ scope: string; ledgerId: number }>;
  failedActions?: FailedAction[];
  clearFailed?: string[];
}

export interface CustomerStore {
  putCustomer(customer: Customer): Promise<void>;
  getCustomer(id: string): Promise<Customer | undefined>;
  listCustomers(filter?: CustomerFilter): Promise<Customer[]>;
  putAssignment(assignment: LineAssignment): Promise<void>;
  listAssignments(filter?: AssignmentFilter): Promise<LineAssignment[]>;
  putWalletEntry(entry: WalletEntry): Promise<void>;
  listWalletEntries(customerId: string): Promise<WalletEntry[]>;
  putPackage(pkg: SellablePackage): Promise<void>;
  getPackage(id: string): Promise<SellablePackage | undefined>;
  listPackages(): Promise<SellablePackage[]>;
  putAllocation(allocation: PackageAllocation): Promise<void>;
  listAllocations(filter?: { customerId?: string; packageId?: string; status?: AllocationStatus }): Promise<PackageAllocation[]>;
  putSnapshot(snapshot: UsageSnapshot): Promise<void>;
  listSnapshots(filter?: { customerId?: string; iccid?: string }): Promise<UsageSnapshot[]>;
  putInvoice(invoice: StoredInvoice): Promise<void>;
  listInvoices(filter?: { customerId?: string }): Promise<StoredInvoice[]>;
  hasApplied(stream: AppliedKey["stream"], key: string): Promise<boolean>;
  getCheckpoint(scope: string): Promise<number>;
  listPending(scope: string): Promise<PendingDetail[]>;
  listFailedActions(): Promise<FailedAction[]>;
  /**
   * Writes wallet rows, package allocations, dedup keys, and checkpoints together.
   * The JSON file store replaces the file atomically and is single-process:
   * two processes can overwrite each other. SQL refuses this call without a
   * transaction callback.
   */
  commitSync(commit: SyncCommit): Promise<void>;
}

interface MemoryDb {
  customers: Customer[];
  assignments: LineAssignment[];
  wallet: WalletEntry[];
  packages: SellablePackage[];
  allocations: PackageAllocation[];
  snapshots: UsageSnapshot[];
  invoices: StoredInvoice[];
  applied: AppliedKey[];
  checkpoints: SyncCheckpoint[];
  pending: PendingDetail[];
  failedActions: FailedAction[];
}

export class MemoryCustomerStore implements CustomerStore {
  protected db: MemoryDb = {
    customers: [],
    assignments: [],
    wallet: [],
    packages: [],
    allocations: [],
    snapshots: [],
    invoices: [],
    applied: [],
    checkpoints: [],
    pending: [],
    failedActions: [],
  };

  async putCustomer(customer: Customer): Promise<void> {
    upsert(this.db.customers, customer);
  }

  async getCustomer(id: string): Promise<Customer | undefined> {
    return this.db.customers.find((item) => item.id === id);
  }

  async listCustomers(filter: CustomerFilter = {}): Promise<Customer[]> {
    return this.db.customers.filter((item) => {
      if (filter.status && item.status !== filter.status) return false;
      if (filter.externalId && item.externalId !== filter.externalId) return false;
      if (filter.tag && !item.tags.includes(filter.tag)) return false;
      return true;
    });
  }

  async putAssignment(assignment: LineAssignment): Promise<void> {
    upsert(this.db.assignments, assignment);
  }

  async listAssignments(filter: AssignmentFilter = {}): Promise<LineAssignment[]> {
    return this.db.assignments.filter((item) => {
      if (filter.customerId && item.customerId !== filter.customerId) return false;
      if (filter.iccid && item.iccid !== filter.iccid) return false;
      if (filter.activeOnly && item.unassignedAt) return false;
      return true;
    });
  }

  async putWalletEntry(entry: WalletEntry): Promise<void> {
    upsert(this.db.wallet, entry);
  }

  async listWalletEntries(customerId: string): Promise<WalletEntry[]> {
    if (!customerId) return [...this.db.wallet];
    return this.db.wallet.filter((item) => item.customerId === customerId);
  }

  async putPackage(pkg: SellablePackage): Promise<void> {
    upsert(this.db.packages, pkg);
  }

  async getPackage(id: string): Promise<SellablePackage | undefined> {
    return this.db.packages.find((item) => item.id === id);
  }

  async listPackages(): Promise<SellablePackage[]> {
    return [...this.db.packages];
  }

  async putAllocation(allocation: PackageAllocation): Promise<void> {
    upsert(this.db.allocations, allocation);
  }

  async listAllocations(filter: { customerId?: string; packageId?: string; status?: AllocationStatus } = {}): Promise<PackageAllocation[]> {
    return this.db.allocations.filter((item) => {
      if (filter.customerId && item.customerId !== filter.customerId) return false;
      if (filter.packageId && item.packageId !== filter.packageId) return false;
      if (filter.status && item.status !== filter.status) return false;
      return true;
    });
  }

  async putSnapshot(snapshot: UsageSnapshot): Promise<void> {
    upsert(this.db.snapshots, snapshot);
  }

  async listSnapshots(filter: { customerId?: string; iccid?: string } = {}): Promise<UsageSnapshot[]> {
    return this.db.snapshots.filter((item) => {
      if (filter.customerId && item.customerId !== filter.customerId) return false;
      if (filter.iccid && item.iccid !== filter.iccid) return false;
      return true;
    });
  }

  async putInvoice(invoice: StoredInvoice): Promise<void> {
    upsert(this.db.invoices, invoice);
  }

  async listInvoices(filter: { customerId?: string } = {}): Promise<StoredInvoice[]> {
    return this.db.invoices.filter((item) => !filter.customerId || item.customerId === filter.customerId);
  }

  async listApplied(): Promise<AppliedKey[]> {
    return [...this.db.applied];
  }

  async hasApplied(stream: AppliedKey["stream"], key: string): Promise<boolean> {
    return this.db.applied.some((item) => item.stream === stream && item.key === key);
  }

  async getCheckpoint(scope: string): Promise<number> {
    return this.db.checkpoints.find((item) => item.scope === scope)?.afterId ?? 0;
  }

  async listPending(scope: string): Promise<PendingDetail[]> {
    return this.db.pending.filter((item) => item.scope === scope);
  }

  async listFailedActions(): Promise<FailedAction[]> {
    return [...this.db.failedActions];
  }

  async commitSync(commit: SyncCommit): Promise<void> {
    const draft = structuredClone(this.db);
    applyCommit(draft, commit);
    this.db = draft;
  }
}

/** Example adapter. One JSON document on disk. Not safe across processes. */
export class JsonFileCustomerStore extends MemoryCustomerStore {
  constructor(private readonly filePath: string) {
    super();
  }

  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const fs = await import("node:fs/promises");
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as MemoryShape;
      await this.replace(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const fs = await import("node:fs/promises");
    const payload = JSON.stringify(await this.dump(), null, 2);
    await fs.writeFile(this.filePath, payload, "utf8");
  }

  private async dump(): Promise<MemoryShape> {
    return {
      customers: await this.listCustomers(),
      assignments: await this.listAssignments(),
      wallet: await super.listWalletEntries(""),
      packages: await this.listPackages(),
      allocations: await this.listAllocations(),
      snapshots: await this.listSnapshots(),
      invoices: await this.listInvoices(),
      applied: await super.listApplied(),
      checkpoints: structuredClone(this.db.checkpoints),
      pending: structuredClone(this.db.pending),
      failedActions: structuredClone(this.db.failedActions),
    };
  }

  private async replace(data: Partial<MemoryShape>): Promise<void> {
    for (const item of data.customers ?? []) await super.putCustomer(item);
    for (const item of data.assignments ?? []) await super.putAssignment(item);
    for (const item of data.wallet ?? []) await super.putWalletEntry(item);
    for (const item of data.packages ?? []) await super.putPackage(item);
    for (const item of data.allocations ?? []) await super.putAllocation(item);
    for (const item of data.snapshots ?? []) await super.putSnapshot(item);
    for (const item of data.invoices ?? []) await super.putInvoice(item);
    await super.commitSync({
      applied: data.applied ?? [],
      checkpoints: data.checkpoints ?? [],
      pending: data.pending ?? [],
      failedActions: data.failedActions ?? [],
    });
  }

  override async putCustomer(customer: Customer): Promise<void> {
    await this.load();
    await super.putCustomer(customer);
    await this.persist();
  }

  override async getCustomer(id: string): Promise<Customer | undefined> {
    await this.load();
    return super.getCustomer(id);
  }

  override async listCustomers(filter?: CustomerFilter): Promise<Customer[]> {
    await this.load();
    return super.listCustomers(filter);
  }

  override async putAssignment(assignment: LineAssignment): Promise<void> {
    await this.load();
    await super.putAssignment(assignment);
    await this.persist();
  }

  override async listAssignments(filter?: AssignmentFilter): Promise<LineAssignment[]> {
    await this.load();
    return super.listAssignments(filter);
  }

  override async putWalletEntry(entry: WalletEntry): Promise<void> {
    await this.load();
    await super.putWalletEntry(entry);
    await this.persist();
  }

  override async listWalletEntries(customerId: string): Promise<WalletEntry[]> {
    await this.load();
    if (!customerId) return super.listWalletEntries("");
    return super.listWalletEntries(customerId);
  }

  override async putPackage(pkg: SellablePackage): Promise<void> {
    await this.load();
    await super.putPackage(pkg);
    await this.persist();
  }

  override async getPackage(id: string): Promise<SellablePackage | undefined> {
    await this.load();
    return super.getPackage(id);
  }

  override async listPackages(): Promise<SellablePackage[]> {
    await this.load();
    return super.listPackages();
  }

  override async putAllocation(allocation: PackageAllocation): Promise<void> {
    await this.load();
    await super.putAllocation(allocation);
    await this.persist();
  }

  override async listAllocations(filter?: { customerId?: string; packageId?: string; status?: AllocationStatus }): Promise<PackageAllocation[]> {
    await this.load();
    return super.listAllocations(filter);
  }

  override async putSnapshot(snapshot: UsageSnapshot): Promise<void> {
    await this.load();
    await super.putSnapshot(snapshot);
    await this.persist();
  }

  override async listSnapshots(filter?: { customerId?: string; iccid?: string }): Promise<UsageSnapshot[]> {
    await this.load();
    return super.listSnapshots(filter);
  }

  override async putInvoice(invoice: StoredInvoice): Promise<void> {
    await this.load();
    await super.putInvoice(invoice);
    await this.persist();
  }

  override async listInvoices(filter?: { customerId?: string }): Promise<StoredInvoice[]> {
    await this.load();
    return super.listInvoices(filter);
  }

  override async hasApplied(stream: AppliedKey["stream"], key: string): Promise<boolean> {
    await this.load();
    return super.hasApplied(stream, key);
  }

  override async getCheckpoint(scope: string): Promise<number> {
    await this.load();
    return super.getCheckpoint(scope);
  }

  override async listPending(scope: string): Promise<PendingDetail[]> {
    await this.load();
    return super.listPending(scope);
  }

  override async listFailedActions(): Promise<FailedAction[]> {
    await this.load();
    return super.listFailedActions();
  }

  override async commitSync(commit: SyncCommit): Promise<void> {
    await this.load();
    const draft = structuredClone(this.db);
    applyCommit(draft, commit);
    const fs = await import("node:fs/promises");
    const payload = JSON.stringify(shapeFrom(draft), null, 2);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, payload, "utf8");
    try {
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    this.db = draft;
  }
}

interface MemoryShape {
  customers: Customer[];
  assignments: LineAssignment[];
  wallet: WalletEntry[];
  packages: SellablePackage[];
  allocations: PackageAllocation[];
  snapshots: UsageSnapshot[];
  invoices: StoredInvoice[];
  applied: AppliedKey[];
  checkpoints: SyncCheckpoint[];
  pending: PendingDetail[];
  failedActions: FailedAction[];
}

function shapeFrom(db: MemoryDb): MemoryShape {
  return {
    customers: db.customers,
    assignments: db.assignments,
    wallet: db.wallet,
    packages: db.packages,
    allocations: db.allocations,
    snapshots: db.snapshots,
    invoices: db.invoices,
    applied: db.applied,
    checkpoints: db.checkpoints,
    pending: db.pending,
    failedActions: db.failedActions,
  };
}

function applyCommit(db: MemoryDb, commit: SyncCommit): void {
  for (const entry of commit.wallet ?? []) db.wallet.push(entry);
  for (const allocation of commit.allocations ?? []) {
    const index = db.allocations.findIndex((item) => item.id === allocation.id);
    if (index >= 0) db.allocations[index] = allocation;
    else db.allocations.push(allocation);
  }
  for (const key of commit.applied ?? []) {
    if (!db.applied.some((item) => item.stream === key.stream && item.key === key.key)) db.applied.push(key);
  }
  for (const checkpoint of commit.checkpoints ?? []) {
    const index = db.checkpoints.findIndex((item) => item.scope === checkpoint.scope);
    if (index >= 0) db.checkpoints[index] = checkpoint;
    else db.checkpoints.push(checkpoint);
  }
  for (const item of commit.clearPending ?? []) {
    db.pending = db.pending.filter((row) => !(row.scope === item.scope && row.ledgerId === item.ledgerId));
  }
  for (const item of commit.pending ?? []) {
    if (!db.pending.some((row) => row.scope === item.scope && row.ledgerId === item.ledgerId)) db.pending.push(item);
  }
  for (const id of commit.clearFailed ?? []) {
    db.failedActions = db.failedActions.filter((item) => item.id !== id);
  }
  for (const action of commit.failedActions ?? []) {
    if (!db.failedActions.some((item) => item.id === action.id)) db.failedActions.push(action);
  }
}

/**
 * ANSI-ish SQL sketch. Pass a query function from your driver.
 * Placeholders are `?`. The statements are the contract; the driver adapts them.
 */
export const CUSTOMER_STORE_SQL = `
CREATE TABLE nxtl_reseller_customers (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  name TEXT,
  email TEXT,
  tags_json TEXT NOT NULL,
  notes TEXT,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_lines (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  iccid TEXT NOT NULL,
  label TEXT,
  assigned_at TEXT NOT NULL,
  unassigned_at TEXT,
  manual_pause INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE nxtl_reseller_wallet (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT,
  reference TEXT
);
CREATE TABLE nxtl_reseller_packages (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_allocations (
  id TEXT PRIMARY KEY,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_snapshots (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  iccid TEXT,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  document_json TEXT NOT NULL
);
CREATE TABLE nxtl_reseller_applied (
  stream TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  PRIMARY KEY (stream, dedup_key)
);
CREATE TABLE nxtl_reseller_checkpoints (
  scope TEXT PRIMARY KEY,
  after_id INTEGER NOT NULL
);
CREATE TABLE nxtl_reseller_pending (
  scope TEXT NOT NULL,
  ledger_id INTEGER NOT NULL,
  iccid TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (scope, ledger_id)
);
CREATE TABLE nxtl_reseller_failed_actions (
  id TEXT PRIMARY KEY,
  iccid TEXT NOT NULL,
  customer_id TEXT,
  kind TEXT NOT NULL,
  error TEXT NOT NULL,
  at TEXT NOT NULL
);
`.trim();

/** Add manual_pause on stores created before that column existed. */
export const CUSTOMER_STORE_MIGRATIONS = [
  "ALTER TABLE nxtl_reseller_lines ADD COLUMN manual_pause INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE nxtl_reseller_failed_actions ADD COLUMN customer_id TEXT",
];

export type SqlQuery = (sql: string, params?: readonly unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Example SQL adapter. It stores JSON documents for the nested records. */
export class SqlCustomerStore implements CustomerStore {
  constructor(
    private readonly query: SqlQuery,
    private readonly transaction?: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>,
  ) {}

  async putCustomer(customer: Customer): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_customers
        (id, external_id, name, email, tags_json, notes, metadata_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        external_id=excluded.external_id, name=excluded.name, email=excluded.email,
        tags_json=excluded.tags_json, notes=excluded.notes, metadata_json=excluded.metadata_json,
        status=excluded.status, updated_at=excluded.updated_at`,
      [
        customer.id,
        customer.externalId ?? null,
        customer.name ?? null,
        customer.email ?? null,
        JSON.stringify(customer.tags),
        customer.notes ?? null,
        JSON.stringify(customer.metadata),
        customer.status,
        customer.createdAt,
        customer.updatedAt,
      ],
    );
  }

  async getCustomer(id: string): Promise<Customer | undefined> {
    const rows = await this.query("SELECT * FROM nxtl_reseller_customers WHERE id = ?", [id]);
    const row = rows[0];
    return row ? customerFromRow(row) : undefined;
  }

  async listCustomers(filter: CustomerFilter = {}): Promise<Customer[]> {
    const rows = await this.query("SELECT * FROM nxtl_reseller_customers", []);
    return rows.map(customerFromRow).filter((item) => {
      if (filter.status && item.status !== filter.status) return false;
      if (filter.externalId && item.externalId !== filter.externalId) return false;
      if (filter.tag && !item.tags.includes(filter.tag)) return false;
      return true;
    });
  }

  async putAssignment(assignment: LineAssignment): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_lines (id, customer_id, iccid, label, assigned_at, unassigned_at, manual_pause)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET unassigned_at=excluded.unassigned_at, label=excluded.label, manual_pause=excluded.manual_pause`,
      [assignment.id, assignment.customerId, assignment.iccid, assignment.label ?? null, assignment.assignedAt, assignment.unassignedAt ?? null, assignment.manualPause ? 1 : 0],
    );
  }

  async listAssignments(filter: AssignmentFilter = {}): Promise<LineAssignment[]> {
    const rows = await this.query("SELECT * FROM nxtl_reseller_lines", []);
    return rows.map(assignmentFromRow).filter((item) => {
      if (filter.customerId && item.customerId !== filter.customerId) return false;
      if (filter.iccid && item.iccid !== filter.iccid) return false;
      if (filter.activeOnly && item.unassignedAt) return false;
      return true;
    });
  }

  async putWalletEntry(entry: WalletEntry): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_wallet (id, customer_id, at, kind, amount, currency, memo, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.customerId, entry.at, entry.kind, entry.amount, entry.currency, entry.memo ?? null, entry.reference ?? null],
    );
  }

  async listWalletEntries(customerId: string): Promise<WalletEntry[]> {
    const rows = await this.query("SELECT * FROM nxtl_reseller_wallet WHERE customer_id = ?", [customerId]);
    return rows.map(walletFromRow);
  }

  async putPackage(pkg: SellablePackage): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_packages (id, document_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json`,
      [pkg.id, JSON.stringify(pkg)],
    );
  }

  async getPackage(id: string): Promise<SellablePackage | undefined> {
    const rows = await this.query("SELECT document_json FROM nxtl_reseller_packages WHERE id = ?", [id]);
    const raw = rows[0]?.document_json;
    return typeof raw === "string" ? JSON.parse(raw) as SellablePackage : undefined;
  }

  async listPackages(): Promise<SellablePackage[]> {
    const rows = await this.query("SELECT document_json FROM nxtl_reseller_packages", []);
    return rows.map((row) => JSON.parse(String(row.document_json)) as SellablePackage);
  }

  async putAllocation(allocation: PackageAllocation): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_allocations (id, document_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json`,
      [allocation.id, JSON.stringify(allocation)],
    );
  }

  async listAllocations(filter: { customerId?: string; packageId?: string; status?: AllocationStatus } = {}): Promise<PackageAllocation[]> {
    const rows = await this.query("SELECT document_json FROM nxtl_reseller_allocations", []);
    return rows.map((row) => JSON.parse(String(row.document_json)) as PackageAllocation).filter((item) => {
      if (filter.customerId && item.customerId !== filter.customerId) return false;
      if (filter.packageId && item.packageId !== filter.packageId) return false;
      if (filter.status && item.status !== filter.status) return false;
      return true;
    });
  }

  async putSnapshot(snapshot: UsageSnapshot): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_snapshots (id, customer_id, iccid, document_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json`,
      [snapshot.id, snapshot.customerId ?? null, snapshot.iccid ?? null, JSON.stringify(snapshot)],
    );
  }

  async listSnapshots(filter: { customerId?: string; iccid?: string } = {}): Promise<UsageSnapshot[]> {
    const rows = await this.query("SELECT document_json FROM nxtl_reseller_snapshots", []);
    return rows.map((row) => JSON.parse(String(row.document_json)) as UsageSnapshot).filter((item) => {
      if (filter.customerId && item.customerId !== filter.customerId) return false;
      if (filter.iccid && item.iccid !== filter.iccid) return false;
      return true;
    });
  }

  async putInvoice(invoice: StoredInvoice): Promise<void> {
    await this.query(
      `INSERT INTO nxtl_reseller_invoices (id, customer_id, document_json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json`,
      [invoice.id, invoice.customerId, JSON.stringify(invoice)],
    );
  }

  async listInvoices(filter: { customerId?: string } = {}): Promise<StoredInvoice[]> {
    const rows = await this.query("SELECT document_json FROM nxtl_reseller_invoices", []);
    return rows.map((row) => JSON.parse(String(row.document_json)) as StoredInvoice).filter((item) => !filter.customerId || item.customerId === filter.customerId);
  }

  async hasApplied(stream: AppliedKey["stream"], key: string): Promise<boolean> {
    const rows = await this.query("SELECT dedup_key FROM nxtl_reseller_applied WHERE stream = ? AND dedup_key = ?", [stream, key]);
    return rows.length > 0;
  }

  async getCheckpoint(scope: string): Promise<number> {
    const rows = await this.query("SELECT after_id FROM nxtl_reseller_checkpoints WHERE scope = ?", [scope]);
    const value = rows[0]?.after_id;
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  async listPending(scope: string): Promise<PendingDetail[]> {
    const rows = await this.query("SELECT * FROM nxtl_reseller_pending WHERE scope = ?", [scope]);
    return rows.map((row) => {
      const item: PendingDetail = { scope, ledgerId: Number(row.ledger_id), iccid: String(row.iccid) };
      if (row.created_at) item.createdAt = String(row.created_at);
      return item;
    });
  }

  async listFailedActions(): Promise<FailedAction[]> {
    const rows = await this.query("SELECT * FROM nxtl_reseller_failed_actions", []);
    return rows.map((row) => {
      const action: FailedAction = {
        id: String(row.id),
        iccid: String(row.iccid),
        kind: "suspend",
        error: String(row.error),
        at: String(row.at),
      };
      if (row.customer_id) action.customerId = String(row.customer_id);
      return action;
    });
  }

  async commitSync(commit: SyncCommit): Promise<void> {
    if (!this.transaction) {
      throw new TypeError("SqlCustomerStore.commitSync requires a transaction callback. Separate writes are not atomic.");
    }
    await this.transaction(async (query) => {
      await applySqlCommit(query, commit);
    });
  }
}

async function applySqlCommit(query: SqlQuery, commit: SyncCommit): Promise<void> {
  for (const entry of commit.wallet ?? []) {
    await query(
      `INSERT INTO nxtl_reseller_wallet (id, customer_id, at, kind, amount, currency, memo, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.customerId, entry.at, entry.kind, entry.amount, entry.currency, entry.memo ?? null, entry.reference ?? null],
    );
  }
  for (const allocation of commit.allocations ?? []) {
    await query(
      `INSERT INTO nxtl_reseller_allocations (id, document_json) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json`,
      [allocation.id, JSON.stringify(allocation)],
    );
  }
  for (const item of commit.applied ?? []) {
    await query(
      "INSERT INTO nxtl_reseller_applied (stream, dedup_key) VALUES (?, ?)",
      [item.stream, item.key],
    );
  }
  for (const checkpoint of commit.checkpoints ?? []) {
    await query(
      `INSERT INTO nxtl_reseller_checkpoints (scope, after_id) VALUES (?, ?)
       ON CONFLICT(scope) DO UPDATE SET after_id=excluded.after_id`,
      [checkpoint.scope, checkpoint.afterId],
    );
  }
  for (const item of commit.clearPending ?? []) {
    await query("DELETE FROM nxtl_reseller_pending WHERE scope = ? AND ledger_id = ?", [item.scope, item.ledgerId]);
  }
  for (const item of commit.pending ?? []) {
    await query(
      `INSERT INTO nxtl_reseller_pending (scope, ledger_id, iccid, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, ledger_id) DO UPDATE SET iccid=excluded.iccid, created_at=excluded.created_at`,
      [item.scope, item.ledgerId, item.iccid, item.createdAt ?? null],
    );
  }
  for (const id of commit.clearFailed ?? []) {
    await query("DELETE FROM nxtl_reseller_failed_actions WHERE id = ?", [id]);
  }
  for (const action of commit.failedActions ?? []) {
    await query(
      `INSERT INTO nxtl_reseller_failed_actions (id, iccid, customer_id, kind, error, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET error=excluded.error, at=excluded.at, customer_id=excluded.customer_id`,
      [action.id, action.iccid, action.customerId ?? null, action.kind, action.error, action.at],
    );
  }
}

function customerFromRow(row: Record<string, unknown>): Customer {
  const customer: Customer = {
    id: String(row.id),
    tags: JSON.parse(String(row.tags_json ?? "[]")) as string[],
    metadata: JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>,
    status: String(row.status) as CustomerStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  if (row.external_id) customer.externalId = String(row.external_id);
  if (row.name) customer.name = String(row.name);
  if (row.email) customer.email = String(row.email);
  if (row.notes) customer.notes = String(row.notes);
  return customer;
}

function assignmentFromRow(row: Record<string, unknown>): LineAssignment {
  const assignment: LineAssignment = {
    id: String(row.id),
    customerId: String(row.customer_id),
    iccid: String(row.iccid),
    assignedAt: String(row.assigned_at),
  };
  if (row.label) assignment.label = String(row.label);
  if (row.unassigned_at) assignment.unassignedAt = String(row.unassigned_at);
  if (Number(row.manual_pause) === 1 || row.manual_pause === true) assignment.manualPause = true;
  return assignment;
}

function walletFromRow(row: Record<string, unknown>): WalletEntry {
  const entry: WalletEntry = {
    id: String(row.id),
    customerId: String(row.customer_id),
    at: String(row.at),
    kind: String(row.kind) as LedgerKind,
    amount: Number(row.amount),
    currency: String(row.currency),
  };
  if (row.memo) entry.memo = String(row.memo);
  if (row.reference) entry.reference = String(row.reference);
  return entry;
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = item;
}
