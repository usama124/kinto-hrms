import 'server-only'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

/**
 * Detailed PDF Salary Slip — exact layout contract:
 *  Company header (name, registered address) + SALARY SLIP title
 *  Employee & payment metadata grid
 *  Side-by-side EARNINGS vs DEDUCTIONS tables
 *  Bank Transferred Amount highlight
 *  INTERNAL LOAN STATUS + INCOME TAX STATUS sub-tables
 *  Employee's / Employer's signature lines
 */

type Doc = jsPDF & { lastAutoTable?: { finalY: number } }

const INK: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [100, 116, 139]
const TEAL: [number, number, number] = [13, 148, 136]
const LINE: [number, number, number] = [203, 213, 225]

export type SalarySlipInput = {
  companyName: string
  companyAddress: string
  monthLabel: string
  issueDate: string
  slip: {
    employeeCode: string
    fullName: string
    fatherName?: string | null
    designation: string
    departmentName: string
    employmentStatus: string
    joiningDate: string
    paymentMode: string
    basicSalary: number
    hrAllowance: number
    utilityAllowance: number
    providentFundEarning: number
    bonus: number
    arrears: number
    grossPay: number
    internalLoan: number
    incomeTax: number
    providentFund: number
    eoobi: number
    taxAdjustment: number
    shortHourDeduction: number
    leaveDeduction: number
    totalDeduction: number
    netPay: number
    workingDays: number
    workedDays: number
    shortMinutes: number
    loanStatus: { loanAmount: number; instNo: number; instAmount: number; paid: number; balance: number } | null
    taxStatus: { taxableEarning: number; taxLiability: number; taxPaid: number; balance: number }
  }
}

const money = (n: number) => `Rs. ${n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function payslipSlipPDF(input: SalarySlipInput): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  paintSlip(doc, input)
  return Buffer.from(doc.output('arraybuffer'))
}

/** Bulk slip collection — one page per employee inside a single PDF. */
export function payslipCollectionPDF(inputs: SalarySlipInput[]): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' }) as Doc
  inputs.forEach((input, i) => {
    if (i > 0) doc.addPage()
    paintSlip(doc, input)
  })
  return Buffer.from(doc.output('arraybuffer'))
}

function paintSlip(doc: Doc, input: SalarySlipInput) {
  const W = doc.internal.pageSize.getWidth()
  const M = 14
  const s = input.slip

  // ── Company header ──
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...INK)
  doc.text(input.companyName, W / 2, 18, { align: 'center' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED)
  doc.text(input.companyAddress, W / 2, 24, { align: 'center' })
  doc.setDrawColor(...TEAL); doc.setLineWidth(0.8); doc.line(M, 29, W - M, 29)

  doc.setFillColor(...INK)
  doc.roundedRect(M, 33, W - 2 * M, 10, 1.5, 1.5, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(255, 255, 255)
  doc.text('S A L A R Y   S L I P', W / 2, 39.5, { align: 'center' })

  // ── Metadata grid ──
  const metaPairs: [string, string, string, string][] = [
    ["Employee's Name", s.fullName, 'Employment #', s.employeeCode],
    ['Designation', s.designation, "Father's Name", s.fatherName || '—'],
    ['Status', s.employmentStatus, 'Date of Joining', s.joiningDate],
    ['Issued By', 'Accounts Dept.', 'Approved By', 'Finance Dept.'],
    ['Payment Mode', s.paymentMode, 'Salary Month', input.monthLabel],
    ['Date', input.issueDate, 'Department', s.departmentName],
  ]
  let y = 50
  doc.setFontSize(8.5)
  for (const [l1, v1, l2, v2] of metaPairs) {
    doc.setTextColor(...MUTED); doc.setFont('helvetica', 'normal')
    doc.text(`${l1}:`, M, y)
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold')
    doc.text(String(v1).slice(0, 42), M + 28, y)
    doc.setTextColor(...MUTED); doc.setFont('helvetica', 'normal')
    doc.text(`${l2}:`, W / 2 + 4, y)
    doc.setTextColor(...INK); doc.setFont('helvetica', 'bold')
    doc.text(String(v2).slice(0, 42), W / 2 + 4 + 30, y)
    y += 5.6
  }
  y += 3

  // ── Side-by-side EARNINGS vs DEDUCTIONS ──
  const colL = M
  const colR = W / 2 + 2
  const colW = (W - 2 * M - 4) / 2
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...TEAL)
  doc.text('E A R N I N G S', colL, y)
  doc.text('D E D U C T I O N S', colR, y)
  y += 2.5

  const earningsRows: [string, number][] = [
    ['Basic Salary', s.basicSalary],
    ['H. R. Allow.', s.hrAllowance],
    ['Utility Allow.', s.utilityAllowance],
    ['Provident Fund', s.providentFundEarning],
    ['Bonus', s.bonus],
    ['Arrears', s.arrears],
  ]
  const deductionRows: [string, number][] = [
    ['Internal Loan', s.internalLoan],
    ['Income Tax', s.incomeTax],
    ['Provident Fund', s.providentFund],
    ['E.O.B.I Contribution', s.eoobi],
    ['Tax Adjustment', s.taxAdjustment],
    ['Short Hours Deduction', s.shortHourDeduction],
    ['Unpaid Leave Deduction', s.leaveDeduction],
  ]

  const tableOpts = (x: number) => ({
    startY: y,
    margin: { left: x },
    tableWidth: colW,
    theme: 'grid' as const,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.8, textColor: [...INK] as [number, number, number], lineColor: [...LINE] as [number, number, number], lineWidth: 0.15 },
    headStyles: { fillColor: [...INK] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] as [number, number, number] },
  })

  autoTable(doc, { ...tableOpts(colL), head: [['Component', 'Amount']], body: earningsRows.map(([c, v]) => [c, money(v)]) as never })
  const leftFinalY = doc.lastAutoTable?.finalY ?? y

  autoTable(doc, { ...tableOpts(colR), head: [['Component', 'Amount']], body: deductionRows.map(([c, v]) => [c, money(v)]) as never })
  const rightFinalY = doc.lastAutoTable?.finalY ?? y

  // Totals row under each table
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...INK)
  doc.setFillColor(241, 245, 249); doc.setDrawColor(...LINE); doc.setLineWidth(0.15)
  doc.rect(colL, leftFinalY + 1.5, colW, 7, 'FD')
  doc.text('Gross Earning', colL + 2, leftFinalY + 5.8)
  doc.text(money(s.grossPay), colL + colW - 2, leftFinalY + 5.8, { align: 'right' })

  doc.rect(colR, rightFinalY + 1.5, colW, 7, 'FD')
  doc.text('Total Deduction', colR + 2, rightFinalY + 5.8)
  doc.text(money(s.totalDeduction), colR + colW - 2, rightFinalY + 5.8, { align: 'right' })

  y = Math.max(leftFinalY, rightFinalY) + 13

  // ── Net pay highlight ──
  doc.setFillColor(209, 250, 229); doc.setDrawColor(...TEAL); doc.setLineWidth(0.4)
  doc.roundedRect(M, y, W - 2 * M, 12, 2, 2, 'FD')
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...INK)
  doc.text('Bank Transferred Amount :', M + 5, y + 7.5)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(4, 120, 87)
  doc.text(money(s.netPay), W - M - 5, y + 8, { align: 'right' })
  y += 17

  // ── Attendance footnote ──
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED)
  doc.text(`Working Days: ${s.workingDays}   ·   Worked Days: ${s.workedDays}   ·   Short Minutes: ${s.shortMinutes}${s.shortHourDeduction > 0 ? '   ·   Short-hours deduction applied per policy' : ''}`, M, y)
  y += 6

  // ── INTERNAL LOAN STATUS ──
  if (s.loanStatus) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...TEAL)
    doc.text('INTERNAL LOAN STATUS', M, y); y += 2
    autoTable(doc, {
      startY: y, margin: { left: M }, tableWidth: W - 2 * M, theme: 'grid',
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.8, textColor: [...INK] as [number, number, number], lineColor: [...LINE] as [number, number, number], lineWidth: 0.15 },
      headStyles: { fillColor: [...INK] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontSize: 8 },
      head: [['Loan Amount Rs.', 'Inst. No.', 'Inst. Amount Rs.', 'Paid', 'Balance']],
      body: [[
        money(s.loanStatus.loanAmount), String(s.loanStatus.instNo), money(s.loanStatus.instAmount),
        money(s.loanStatus.paid), money(s.loanStatus.balance),
      ]] as never,
    })
    y = (doc.lastAutoTable?.finalY ?? y) + 8
  }

  // ── INCOME TAX STATUS ──
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...TEAL)
  doc.text('INCOME TAX STATUS', M, y); y += 2
  autoTable(doc, {
    startY: y, margin: { left: M }, tableWidth: W - 2 * M, theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.8, textColor: [...INK] as [number, number, number], lineColor: [...LINE] as [number, number, number], lineWidth: 0.15 },
    headStyles: { fillColor: [...INK] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontSize: 8 },
    head: [['Taxable Earning Rs.', 'Tax Liability Rs.', 'Tax Paid Rs.', 'Balance Rs.']],
    body: [[money(s.taxStatus.taxableEarning), money(s.taxStatus.taxLiability), money(s.taxStatus.taxPaid), money(s.taxStatus.balance)]] as never,
  })
  y = (doc.lastAutoTable?.finalY ?? y) + 14

  // ── Signature lines ──
  const sigY = Math.min(y + 6, doc.internal.pageSize.getHeight() - 30)
  doc.setDrawColor(...MUTED); doc.setLineWidth(0.3)
  doc.line(M, sigY, M + 60, sigY)
  doc.line(W - M - 60, sigY, W - M, sigY)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK)
  doc.text("Employee's Signature", M, sigY + 5)
  doc.text("Employer's Signature", W - M, sigY + 5, { align: 'right' })

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED)
  doc.text(`This is a computer-generated salary slip · ${input.companyName} · ${input.monthLabel}`, W / 2, doc.internal.pageSize.getHeight() - 10, { align: 'center' })
}
