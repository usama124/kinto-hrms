import { db, ctx, removeTestDevices } from './ctx'
import { DOMAIN } from './lib'

/** Leave the database the way the demo accounts expect it: usable with the shared password, MFA re-enrolled at first sign-in. */
export async function teardown() {
  console.log('\n▶ Teardown')
  // 1) MFA: the harness enrolled authenticators it alone knows the secrets of → clear them so a human can enrol their own
  const r = await db.user.updateMany({
    where: { email: { endsWith: DOMAIN }, mfaEnabled: true },
    data: { mfaEnabled: false, mfaSecret: null, backupCodes: null, failedAttempts: 0, lockedUntil: null },
  })
  console.log(`   MFA reset on ${r.count} demo account(s)`)
  await db.user.updateMany({ where: { email: { endsWith: DOMAIN } }, data: { failedAttempts: 0, lockedUntil: null } })
  // sessions of the harness are meaningless afterwards
  await db.refreshToken.deleteMany({ where: { user: { email: { endsWith: DOMAIN } } } })

  // 2) throwaway accounts created by tests
  for (const id of ctx.createdUserIds) await purgeUser(id)
  if (ctx.createdUserIds.length) console.log(`   removed ${ctx.createdUserIds.length} throwaway account(s)`)
  // belt and braces: anything tagged e2e-*
  const strays = await db.user.findMany({ where: { email: { startsWith: 'e2e.' } }, select: { id: true } })
  for (const s of strays) await purgeUser(s.id)
  if (strays.length) console.log(`   removed ${strays.length} stray e2e account(s)`)

  // 3) test artefacts that are not people
  await removeTestDevices()
  const { cleanupPayrollTestData } = await import('./phase5-payroll')
  await cleanupPayrollTestData()
  const { cleanupAdminTestData } = await import('./phase6-admin')
  await cleanupAdminTestData()
  await db.designation.deleteMany({ where: { name: { startsWith: 'E2E ' } } }).catch(() => undefined)
  console.log('   done')
}

export async function purgeUser(id: string) {
  const reqs = await db.request.findMany({ where: { userId: id }, select: { id: true } })
  await db.approvalLog.deleteMany({ where: { OR: [{ approverId: id }, { requestId: { in: reqs.map((x) => x.id) } }] } })
  await db.request.deleteMany({ where: { userId: id } })
  const areqs = await db.attendanceRequest.findMany({ where: { userId: id }, select: { id: true } })
  await db.attendanceApproval.deleteMany({ where: { OR: [{ approverId: id }, { requestId: { in: areqs.map((x) => x.id) } }] } })
  await db.attendanceRequest.deleteMany({ where: { userId: id } })
  const logs = await db.attendanceLog.findMany({ where: { userId: id }, select: { id: true } })
  await db.attendanceAudit.deleteMany({ where: { OR: [{ adminId: id }, { attendanceId: { in: logs.map((x) => x.id) } }] } })
  await db.breakLog.deleteMany({ where: { attendanceId: { in: logs.map((x) => x.id) } } })
  await db.attendanceLog.deleteMany({ where: { userId: id } })
  await db.biometricPunch.deleteMany({ where: { userId: id } })
  await db.leaveBalance.deleteMany({ where: { userId: id } })
  await db.notification.deleteMany({ where: { userId: id } })
  await db.refreshToken.deleteMany({ where: { userId: id } })
  await db.payslip.deleteMany({ where: { userId: id } })
  await db.loan.deleteMany({ where: { userId: id } })
  await db.monthlyAdjustment.deleteMany({ where: { userId: id } })
  await db.user.updateMany({ where: { OR: [{ teamLeadId: id }, { managerId: id }] }, data: { teamLeadId: null, managerId: null } })
  await db.team.updateMany({ where: { teamLeadId: id }, data: { teamLeadId: null } })
  await db.department.updateMany({ where: { managerId: id }, data: { managerId: null } })
  const ups = await db.upload.findMany({ where: { uploadedById: id }, select: { id: true } })
  await db.user.update({ where: { id }, data: { avatarUploadId: null } }).catch(() => undefined)
  await db.upload.deleteMany({ where: { id: { in: ups.map((u) => u.id) } } })
  await db.user.delete({ where: { id } }).catch((e) => console.log(`   (could not delete ${id}: ${String(e).slice(0, 80)})`))
}
