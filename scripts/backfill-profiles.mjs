// One-off: backfill extended profile fields for existing demo users.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
let seed = 42
const rand = (min, max) => { seed = (seed * 9301 + 49297) % 233280; return min + Math.floor((seed / 233280) * (max - min + 1)) }
const pick = (arr) => arr[rand(0, arr.length - 1)]

const femaleFirst = ['Fatima', 'Hira', 'Mahnoor', 'Zara', 'Nadia', 'Rabia', 'Ayesha']

const users = await db.user.findMany({ select: { id: true, fullName: true, motherName: true, nationality: true } })
for (const u of users) {
  if (u.motherName && u.nationality) continue // already backfilled
  const first = u.fullName.split(' ')[0]
  const last = u.fullName.split(' ').slice(-1)[0]
  const dobYear = 1985 + rand(0, 15)
  await db.user.update({
    where: { id: u.id },
    data: {
      motherName: u.motherName ?? `Bibi ${first}`,
      personalEmail: `${first.toLowerCase()}.${rand(10, 99)}@gmail.com`,
      cnicExpiry: `${rand(2027, 2036)}-${String(rand(1, 12)).padStart(2, '0')}-${String(rand(1, 28)).padStart(2, '0')}`,
      drivingLicense: rand(0, 3) === 0 ? null : `KHI-${rand(2015, 2025)}-${rand(100000, 999999)}`,
      passportNo: rand(0, 3) === 0 ? null : `AB${rand(1000000, 9999999)}`,
      passportExpiry: `${rand(2027, 2034)}-${String(rand(1, 12)).padStart(2, '0')}-${String(rand(1, 28)).padStart(2, '0')}`,
      dateOfBirth: new Date(`${dobYear}-${String(rand(1, 12)).padStart(2, '0')}-${String(rand(1, 28)).padStart(2, '0')}T00:00:00Z`),
      gender: femaleFirst.includes(first) ? 'Female' : 'Male',
      maritalStatus: pick(['Married', 'Single', 'Single', 'Married']),
      bloodGroup: pick(['A+', 'B+', 'O+', 'AB+', 'A-', 'O-']),
      religion: 'Islam',
      nationality: 'Pakistani',
      emergencyContactName: `${pick(['Aslam', 'Rashid', 'Nasir', 'Kiran', 'Sana'])} ${last}`,
      emergencyContactPhone: `+92 3${rand(0, 4)}${rand(0, 9)} ${rand(7000000, 9999999)}`,
      bankName: pick(['MEZN Bank', 'HBL', 'UBL', 'MCB', 'Bank Alfalah']),
    },
  })
}
console.log(`Backfilled profile fields for ${users.length} users.`)
await db.$disconnect()
