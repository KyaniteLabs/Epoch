export interface Env {
	DB: D1Database;
}

export type Transport = "mcp-stdio" | "mcp-http" | "cli" | "rest";
export type RuntimeHint = "agent" | "human" | "unknown";

export interface AnonymizedRecord {
	task_type: string;
	complexity: number | null;
	tool: string;
	estimated_hours: number;
	actual_hours: number;
	ratio: number;
	date: string;
	completed_at?: string;
}

export interface SubmissionPayloadV1 {
	schema_version: 1;
	installation_id: string;
	epoch_version: string;
	records: AnonymizedRecord[];
	generated_at: string;
}

export interface SubmissionPayloadV2 {
	schema_version: 2;
	installation_id: string;
	epoch_version: string;
	records: AnonymizedRecord[];
	generated_at: string;
	client_name: string | null;
	client_version: string | null;
	transport: Transport | null;
	runtime_hint: RuntimeHint | null;
}

export type SubmissionPayload = SubmissionPayloadV1 | SubmissionPayloadV2;
