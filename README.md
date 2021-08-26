# mysql-dynamic-cluster
mysql cluster implementation with dynamic  limit and hashing logic 

Logic:
1. Init cluster with database connection params
2. Connect to databases
3. Order connections by fast reply
4. Make transaction to relevant connection
