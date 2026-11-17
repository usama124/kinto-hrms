-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_departmentId_isActive_idx" ON "User"("departmentId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_teamId_idx" ON "User"("teamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_teamLeadId_isActive_idx" ON "User"("teamLeadId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_managerId_isActive_idx" ON "User"("managerId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_isActive_role_idx" ON "User"("isActive", "role");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_designationId_idx" ON "User"("designationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_shiftId_idx" ON "User"("shiftId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Request_userId_status_idx" ON "Request"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Request_status_currentStage_idx" ON "Request"("status", "currentStage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Request_userId_createdAt_idx" ON "Request"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Request_leaveTypeId_idx" ON "Request"("leaveTypeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalLog_requestId_idx" ON "ApprovalLog"("requestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalLog_approverId_idx" ON "ApprovalLog"("approverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceLog_dateKey_idx" ON "AttendanceLog"("dateKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceLog_dateKey_status_idx" ON "AttendanceLog"("dateKey", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BreakLog_attendanceId_idx" ON "BreakLog"("attendanceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceAudit_attendanceId_idx" ON "AttendanceAudit"("attendanceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceRequest_userId_status_idx" ON "AttendanceRequest"("userId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceRequest_status_currentStage_idx" ON "AttendanceRequest"("status", "currentStage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceRequest_userId_createdAt_idx" ON "AttendanceRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceApproval_requestId_idx" ON "AttendanceApproval"("requestId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AttendanceApproval_approverId_idx" ON "AttendanceApproval"("approverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BiometricPunch_userId_ts_idx" ON "BiometricPunch"("userId", "ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BiometricPunch_ts_idx" ON "BiometricPunch"("ts");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payslip_userId_idx" ON "Payslip"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Loan_userId_idx" ON "Loan"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Upload_uploadedById_idx" ON "Upload"("uploadedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_targetUserId_createdAt_idx" ON "AuditLog"("targetUserId", "createdAt");

