import 'server-only'
import ExcelJS from 'exceljs'
import type { DetailedCalc } from '@/lib/hrms/payroll-v2'

/**
 * Formatted .xlsx Payroll Master Sheet — exact column contract:
 * Employee ID | Employee Name | Father's Name | Department | Designation |
 * Total Working Days | Total Worked Days | Paid Leaves | Unpaid / Uninformed Leaves |
 * Total Short Hours | Basic Salary | Allowances (H.R. + Utility) | Bonus / Arrears |
 * Gross Salary | Short-Hours Deduction | Unpaid Leave Deduction | Income Tax |
 * E.O.B.I / PF | Loan Installment | Total Deductions | Final Net Payable Salary
 */
export async function payrollMasterSheet(monthLabel: string, rows: DetailedCalc[], companyName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'NovaTech HRMS'
  wb.created = new Date()

  const ws = wb.addWorksheet(`Payroll ${monthLabel}`, {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })

  const HEADERS = [
    'Employee ID', 'Employee Name', "Father's Name", 'Department', 'Designation',
    'Total Working Days', 'Total Worked Days', 'Paid Leaves', 'Unpaid / Uninformed Leaves',
    'Total Short Hours', 'Basic Salary', 'Allowances (H.R. + Utility)', 'Bonus / Arrears',
    'Gross Salary', 'Short-Hours Deduction', 'Unpaid Leave Deduction', 'Income Tax',
    'E.O.B.I / PF', 'Loan Installment', 'Total Deductions', 'Final Net Payable Salary',
  ]
  const MONEY_COLS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] // 1-based excel columns

  // Title band
  ws.mergeCells(1, 1, 1, HEADERS.length)
  const title = ws.getCell(1, 1)
  title.value = `${companyName} — Payroll Master Sheet · ${monthLabel}`
  title.font = { bold: true, size: 14, color: { argb: 'FF0F172A' } }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 26

  ws.mergeCells(2, 1, 2, HEADERS.length)
  const sub = ws.getCell(2, 1)
  sub.value = `Generated ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })} · Currency: PKR · Confidential`
  sub.font = { size: 9, color: { argb: 'FF64748B' } }
  sub.alignment = { horizontal: 'center' }

  // Header row
  const headerRow = ws.getRow(3)
  headerRow.values = HEADERS
  headerRow.height = 30
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0D9488' } } }
  })

  // Data rows
  rows.forEach((r, idx) => {
    const row = ws.addRow([
      r.employeeCode,
      r.fullName,
      r.fatherName ?? '—',
      r.departmentName,
      r.designation,
      r.workingDays,
      r.workedDays,
      r.paidLeaves,
      r.unpaidLeaveDays,
      round2(r.shortMinutes / 60),
      r.basicSalary,
      round2(r.hrAllowance + r.utilityAllowance),
      round2(r.bonus + r.arrears),
      r.grossPay,
      r.shortHourDeduction,
      round2(r.leaveDeduction),
      r.incomeTax,
      round2(r.eoobi + r.providentFund),
      r.internalLoan,
      r.totalDeduction,
      r.netPay,
    ])
    row.height = 18
    const banded = idx % 2 === 1
    row.eachCell((cell, col) => {
      cell.font = { size: 9, name: 'Calibri' }
      cell.alignment = { vertical: 'middle', horizontal: col <= 5 ? 'left' : 'right' }
      if (banded) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6FB' } }
      if (MONEY_COLS.includes(col)) cell.numFmt = '#,##0.00'
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }
    })
  })

  // Totals row
  const sum = (pick: (r: DetailedCalc) => number) => round2(rows.reduce((s, r) => s + pick(r), 0))
  const totalsRow = ws.addRow([
    '', 'TOTAL', '', '', '',
    '', '', sum((r) => r.paidLeaves), sum((r) => r.unpaidLeaveDays),
    round2(sum((r) => r.shortMinutes) / 60), sum((r) => r.basicSalary),
    sum((r) => r.hrAllowance + r.utilityAllowance), sum((r) => r.bonus + r.arrears),
    sum((r) => r.grossPay), sum((r) => r.shortHourDeduction), sum((r) => r.leaveDeduction),
    sum((r) => r.incomeTax), sum((r) => r.eoobi + r.providentFund), sum((r) => r.internalLoan),
    sum((r) => r.totalDeduction), sum((r) => r.netPay),
  ])
  totalsRow.eachCell((cell, col) => {
    cell.font = { bold: true, size: 9, color: { argb: 'FF0F172A' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
    if (MONEY_COLS.includes(col)) cell.numFmt = '#,##0.00'
    cell.alignment = { vertical: 'middle', horizontal: col <= 5 ? 'left' : 'right' }
    cell.border = { top: { style: 'double', color: { argb: 'FF0F766E' } } }
  })

  // Column widths
  const widths = [12, 22, 20, 14, 26, 10, 10, 10, 12, 11, 13, 14, 12, 13, 13, 13, 11, 11, 12, 13, 16]
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
