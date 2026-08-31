export type CaseSeverity = "low" | "medium" | "high";

export interface ServiceCase {
  id: string;
  createdAt: string;
  vehicle: string;
  summary: string;
  severity: CaseSeverity;
  status: "open";
}

const cases = new Map<string, ServiceCase>();
let nextCaseNumber = 1000;

export function createCase(input: {
  vehicle: string;
  summary: string;
  severity: CaseSeverity;
}): ServiceCase {
  const serviceCase: ServiceCase = {
    id: `BMW-${nextCaseNumber++}`,
    createdAt: new Date().toISOString(),
    status: "open",
    ...input,
  };
  cases.set(serviceCase.id, serviceCase);
  return serviceCase;
}

export function listCases(): ServiceCase[] {
  return [...cases.values()];
}

export function clearCases(): void {
  cases.clear();
}
