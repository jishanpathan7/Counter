/** Demo data, matching the batch from the reel, so a fresh install has something to click through. */
export function seedDemo(service) {
  if (service.listBatches().length) return false;
  service.updateSettings({ instituteName: 'Demo Coaching Centre' });

  const allDays = [0, 1, 2, 3, 4, 5, 6];
  const batchA = service.createBatch({ name: 'Batch A', startTime: '07:00', days: allDays });
  const batchB = service.createBatch({ name: 'Batch B', startTime: '16:00', days: allDays });

  const students = [
    [batchB, 'Aarav', 'Mr. Sharma', '9000000001'],
    [batchB, 'Diya', 'Mrs. Iyer', '9000000002'],
    [batchB, 'Rohan', 'Mr. Verma', '9000000003'],
    [batchB, 'Meera', 'Mrs. Nair', '9000000004'],
    [batchA, 'Kabir', 'Mr. Khan', '9000000005'],
    [batchA, 'Ananya', 'Mrs. Gupta', '9000000006'],
    [batchA, 'Ishaan', 'Mr. Patel', '9000000007'],
  ];
  for (const [batch, name, parentName, parentPhone] of students) {
    service.createStudent({ batchId: batch.id, name, parentName, parentPhone });
  }
  return true;
}
