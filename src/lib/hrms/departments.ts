import 'server-only'

/** Shape sent to the browser. */
export const departmentDto = (d: {
  id: string; name: string; code: string; description: string | null; isActive: boolean
  manager?: { fullName: string } | null; _count?: { users: number; teams: number; designations: number }
}) => ({
  id: d.id, name: d.name, code: d.code, description: d.description, isActive: d.isActive,
  managerName: d.manager?.fullName ?? null,
  employeeCount: d._count?.users ?? 0, teamCount: d._count?.teams ?? 0, designationCount: d._count?.designations ?? 0,
})
