import 'server-only'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { APP_NAME } from '@/lib/hrms/constants'
import { fmtDateTime } from '@/lib/hrms/dates'

// ─── Brand palette ────────────────────────────────────────────────────────────
const INK = [30, 41, 59] as const      // slate-800
const TEAL = [13, 148, 136] as const   // teal-600 (brand)
const MUTED = [100, 116, 139] as const // slate-500
const LINE = [226, 232, 240] as const  // slate-200
const CANVAS = [244, 246, 251] as const

type Doc = jsPDF & { lastAutoTable?: { finalY: number } }

const TONES: Record<string, [number, number, number]> = {
  emerald: [5, 150, 105], amber: [217, 119, 6], rose: [225, 29, 72], orange: [234, 88, 12],
  slate: [100, 116, 139], sky: [2, 132, 199], cyan: [8, 145, 178], teal: [13, 148, 136],
  violet: [124, 58, 237], purple: [147, 51, 234], indigo: [79, 70, 229],
}

function header(doc: Doc, title: string, subtitle?: string) {
  const W = doc.internal.pageSize.getWidth()
  doc.setFillColor(...INK)
  doc.rect(0, 0, W, 26, 'F')
  doc.setFillColor(...TEAL)
  doc.rect(0, 26, W, 1.6, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text(APP_NAME, 14, 12)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(203, 213, 225)
  doc.text('People · Attendance · Payroll — Unified Suite', 14, 18.5)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(255, 255, 255)
  doc.text(title, W - 14, 12, { align: 'right' })
  if (subtitle) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(203, 213, 225)
    doc.text(subtitle, W - 14, 18.5, { align: 'right' })
  }
}

function footer(doc: Doc) {
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const page = doc.getNumberOfPages()
  for (let i = 1; i <= page; i++) {
    doc.setPage(i)
    doc.setDrawColor(...LINE)
    doc.line(14, H - 12, W - 14, H - 12)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(`Generated ${fmtDateTime(new Date())} · Confidential — ${APP_NAME}`, 14, H - 7)
    doc.text(`Page ${i} of ${page}`, W - 14, H - 7, { align: 'right' })
  }
}

function metaLine(doc: Doc, y: number, label: string, value: string) {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED)
  doc.text(label, 14, y)
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK)
  doc.text(value, 14 + doc.getTextWidth(label) + 3, y)
}

function kpiBlocks(doc: Doc, startY: number, items: { label: string; value: string; accent?: string }[]): number {
  const W = doc.internal.pageSize.getWidth()
  const perRow = Math.min(items.length, 4)
  const gap = 4
  const bw = (W - 28 - gap * (perRow - 1)) / perRow
  const bh = 20
  items.forEach((it, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    const x = 14 + col * (bw + gap)
    const y = startY + row * (bh + gap)
    doc.setFillColor(...CANVAS)
    doc.setDrawColor(...LINE)
    doc.roundedRect(x, y, bw, bh, 2.5, 2.5, 'FD')
    const accent = TONES[it.accent ?? 'teal'] ?? TEAL
    doc.setFillColor(...accent)
    doc.roundedRect(x, y, 2.2, bh, 1, 1, 'F')
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED)
    doc.text(it.label.toUpperCase(), x + 5, y + 7.5)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...INK)
    doc.text(it.value, x + 5, y + 15.5)
  })
  return startY + Math.ceil(items.length / perRow) * (bh + gap)
}

function badge(doc: Doc, x: number, y: number, text: string, tone: string): number {
  const c = TONES[tone] ?? TONES.slate
  doc.setFont('helvetica', 'bold'); doc.setFontSize(6.8)
  const w = doc.getTextWidth(text) + 5
  doc.setFillColor(c[0], c[1], c[2])
  doc.roundedRect(x, y - 3.6, w, 6, 1.4, 1.4, 'F')
  doc.setTextColor(255, 255, 255)
  doc.text(text, x + 2.5, y + 0.6)
  return w
}

function sectionTitle(doc: Doc, y: number, title: string): number {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...INK)
  doc.text(title, 14, y)
  doc.setDrawColor(...TEAL); doc.setLineWidth(0.8)
  doc.line(14, y + 2, 14 + 18, y + 2)
  doc.setLineWidth(0.2)
  return y + 8
}

function table(doc: Doc, y: number, head: string[], body: (string | number)[][], toneMap?: (rowIdx: number) => string): number {
  autoTable(doc, {
    startY: y,
    head: [head],
    body: body as never,
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.6, cellPadding: 2.2, textColor: [...INK], lineColor: [...LINE], lineWidth: 0.15 },
    headStyles: { fillColor: [...INK], textColor: [255, 255, 255], fontSize: 7.4 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 14, right: 14 },
  })
  void toneMap
  return (doc.lastAutoTable?.finalY ?? y) + 6
}

// ─── 1. Individual Employee 360° Report ───────────────────────────────────────

export type IndividualReportInput = {
  employee: { fullName: string; employeeCode: string; designation: string; department: string; roleLabel: string; joiningDate: string; teamLead: string; manager: string }
  rangeLabel: string
  attendanceScore: number
  kpis: { label: string; value: string; accent?: string }[]
  timesheetRows: (string | number)[][]
  lateFrequency: { label: string; value: string }[]
  leaveLedger: (string | number)[][]
  payrollRows: (string | number)[][]
}

export function individualReportPDF(input: IndividualReportInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  header(doc, 'Individual Employee 360° Report', `Range: ${input.rangeLabel}`)
  let y = 36
  metaLine(doc, y, 'Employee: ', `${input.employee.fullName} (${input.employee.employeeCode})`); y += 5.5
  metaLine(doc, y, 'Designation: ', `${input.employee.designation} · ${input.employee.department}`); y += 5.5
  metaLine(doc, y, 'Reporting Line: ', `TL ${input.employee.teamLead} → Mgr ${input.employee.manager}`); y += 5.5
  metaLine(doc, y, 'Attendance Score: ', `${input.attendanceScore}%`); y += 8

  y = sectionTitle(doc, y, 'Summary KPIs')
  y = kpiBlocks(doc, y, input.kpis)

  y = sectionTitle(doc, y + 2, 'Late Check-in Frequency (top days)')
  autoTable(doc, {
    startY: y,
    head: [['Date', 'Late By', 'Check-in']],
    body: input.lateFrequency.length ? input.lateFrequency.map((f) => [f.label, f.value, '—']) : [['No late arrivals in range', '—', '—']],
    theme: 'plain', styles: { fontSize: 7.6, cellPadding: 1.6, textColor: [...INK] },
    margin: { left: 14, right: 14 },
  })
  y = (doc.lastAutoTable?.finalY ?? y) + 6

  y = sectionTitle(doc, y, 'Leave Ledger')
  y = table(doc, y, ['Leave Type', 'Carry Fwd', 'Availed', 'Pending', 'Lapsed', 'Available'], input.leaveLedger)

  y = sectionTitle(doc, y, 'Payroll / Deduction History')
  table(doc, y, ['Month', 'Gross', 'Short-min', 'Short Ded.', 'Unpaid Ded.', 'Overtime', 'Net Pay'], input.payrollRows)

  footer(doc)
  return Buffer.from(doc.output('arraybuffer'))
}

// ─── 2. Org Attendance & Short-Hours Summary ──────────────────────────────────

export type OrgReportInput = {
  rangeLabel: string
  kpis: { label: string; value: string; accent?: string }[]
  deptRows: (string | number)[][]
  monthRows: (string | number)[][]
}

export function orgAttendancePDF(input: OrgReportInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  header(doc, 'Monthly Org Attendance & Short-Hours Summary', `Range: ${input.rangeLabel}`)
  let y = 36
  y = sectionTitle(doc, y, 'Organization KPIs')
  y = kpiBlocks(doc, y, input.kpis)
  y = sectionTitle(doc, y + 2, 'Department Comparison')
  y = table(doc, y, ['Department', 'Employees', 'Short Hours', 'Absent Days', 'Avg Punctuality'], input.deptRows)
  y = sectionTitle(doc, y, 'Monthly Trend')
  table(doc, y, ['Month', 'Attendance Rate', 'Punctuality Rate', 'Short Minutes', 'Absent Days'], input.monthRows)
  footer(doc)
  return Buffer.from(doc.output('arraybuffer'))
}

// ─── 3. Leave Utilization & Balance Audit ─────────────────────────────────────

export type LeaveAuditInput = {
  rangeLabel: string
  kpis: { label: string; value: string; accent?: string }[]
  utilRows: (string | number)[][]
  balanceRows: (string | number)[][]
}

export function leaveAuditPDF(input: LeaveAuditInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  header(doc, 'Monthly Leave Utilization & Balance Audit', `Range: ${input.rangeLabel}`)
  let y = 36
  y = sectionTitle(doc, y, 'Leave KPIs')
  y = kpiBlocks(doc, y, input.kpis)
  y = sectionTitle(doc, y + 2, 'Utilization by Leave Type')
  y = table(doc, y, ['Leave Type', 'Requests', 'Days Availed', 'Pending', 'Rejected'], input.utilRows)
  y = sectionTitle(doc, y, 'Balance Audit (per employee)')
  table(doc, y, ['Employee', 'Leave Type', 'Carry Fwd', 'Availed', 'Pending', 'Lapsed', 'Available'], input.balanceRows)
  footer(doc)
  return Buffer.from(doc.output('arraybuffer'))
}

// ─── 4. Payroll Register (bundle) ─────────────────────────────────────────────

export type PayrollRegisterInput = {
  monthLabel: string
  kpis: { label: string; value: string; accent?: string }[]
  rows: (string | number)[][]
}

export function payrollRegisterPDF(input: PayrollRegisterInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  header(doc, 'Monthly Payroll Register', input.monthLabel)
  let y = 36
  y = sectionTitle(doc, y, 'Payroll Summary')
  y = kpiBlocks(doc, y, input.kpis)
  y = sectionTitle(doc, y + 2, 'Payroll Register')
  table(doc, y, ['Employee', 'Gross', 'Short-min', 'Short Ded.', 'Unpaid Days', 'Leave Ded.', 'Overtime', 'Net Pay'], input.rows)
  footer(doc)
  return Buffer.from(doc.output('arraybuffer'))
}

// ─── Payslip ──────────────────────────────────────────────────────────────────

export type PayslipInput = {
  monthLabel: string
  employee: { fullName: string; employeeCode: string; designation: string; department: string }
  baseSalary: number; allowances: number; grossPay: number
  shortMinutes: number; leaveDaysEquivalent: number; shortConvertedFromBalance: number
  shortHourDeduction: number; unpaidLeaveDays: number; leaveDeduction: number
  overtimeAmount: number; netPay: number
}

export function payslipPDF(p: PayslipInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  header(doc, 'Salary Payslip', p.monthLabel)
  let y = 36
  metaLine(doc, y, 'Employee: ', `${p.employee.fullName} (${p.employee.employeeCode})`); y += 5.5
  metaLine(doc, y, 'Designation: ', `${p.employee.designation} · ${p.employee.department}`); y += 8

  y = sectionTitle(doc, y, 'Earnings')
  y = table(doc, y, ['Component', 'Amount (PKR)'], [
    ['Base Salary', p.baseSalary.toFixed(2)],
    ['Allowances', p.allowances.toFixed(2)],
    ['Gross Pay', p.grossPay.toFixed(2)],
  ])
  y = sectionTitle(doc, y, 'Deductions & Additions')
  y = table(doc, y, ['Component', 'Amount (PKR)'], [
    [`Short-hours (${p.shortMinutes} min → ${p.leaveDaysEquivalent} day equiv., ${p.shortConvertedFromBalance} from balance)`, p.shortHourDeduction.toFixed(2)],
    [`Unpaid leave (${p.unpaidLeaveDays} day(s))`, p.leaveDeduction.toFixed(2)],
    ['Overtime credit', p.overtimeAmount.toFixed(2)],
  ])
  const W = doc.internal.pageSize.getWidth()
  doc.setFillColor(...CANVAS); doc.setDrawColor(...LINE)
  doc.roundedRect(W - 94, y - 2, 80, 16, 2.5, 2.5, 'FD')
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED)
  doc.text('NET PAY (PKR)', W - 86, y + 5)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...TEAL)
  doc.text(`PKR ${p.netPay.toFixed(2)}`, W - 86, y + 11.5)
  y += 22
  badge(doc, 14, y, p.shortHourDeduction + p.leaveDeduction > 0 ? 'DEDUCTIONS APPLIED' : 'NO DEDUCTIONS', p.shortHourDeduction + p.leaveDeduction > 0 ? 'amber' : 'emerald')
  footer(doc)
  return Buffer.from(doc.output('arraybuffer'))
}

// ─── Employee Profile Card ────────────────────────────────────────────────────

export function profileCardPDF(p: {
  fullName: string; employeeCode: string; designation: string; department: string
  roleLabel: string; joiningDate: string; email: string; teamLead: string; manager: string
  shift: string; completionPct: number
}): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  header(doc, 'Employee Profile Card', p.employeeCode)
  let y = 40
  doc.setFillColor(...CANVAS); doc.setDrawColor(...LINE)
  doc.roundedRect(14, y, doc.internal.pageSize.getWidth() - 28, 64, 3, 3, 'FD')
  doc.setFillColor(...TEAL)
  doc.circle(28, y + 18, 9, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(255, 255, 255)
  doc.text(p.fullName.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase(), 28, y + 20, { align: 'center' })
  doc.setFontSize(14); doc.setTextColor(...INK)
  doc.text(p.fullName, 44, y + 14)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED)
  doc.text(`${p.designation} · ${p.department} · ${p.roleLabel}`, 44, y + 21)
  badge(doc, 44, y + 30, `CODE ${p.employeeCode}`, 'teal')
  badge(doc, 44 + 30, y + 30, `PROFILE ${p.completionPct}%`, p.completionPct >= 90 ? 'emerald' : 'amber')
  const rows: (string | number)[][] = [
    ['Email', p.email], ['Joining Date', p.joiningDate], ['Shift', p.shift],
    ['Team Lead', p.teamLead], ['Manager', p.manager],
  ]
  table(doc, y + 70, ['Field', 'Value'], rows)
  footer(doc)
  return Buffer.from(doc.output('arraybuffer'))
}
